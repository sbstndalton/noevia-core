'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { toTypeSafe, fromTypeSafe, contractProblem } = require('./adapter.cjs');
const { createDecisionEndpoint } = require(path.join(__dirname, '..', '..', 'server', 'decision-endpoint.cjs'));

const body = { state: 'hi there', question: 'Which role?', options: [{ id: 'fast', label: 'Short' }, { id: 'smart', label: 'Long' }, { id: 'code', label: 'Code' }] };
const answer = (probabilities) => ({ model: 'laya:multilingual', answers: { d: { type: 'choice', choice: 'x', confidence: 0.5, probabilities } }, usage: { input_tokens: 9, output_tokens: 0 } });
const reasonOf = (fn) => { try { fn(); } catch (e) { return e.reason; } return null; };

test('toTypeSafe: one choice question, criteria in option order, the question as instructions', () => {
  const ts = toTypeSafe(body, 'laya:multilingual');
  assert.deepEqual(ts, { model: 'laya:multilingual', state: 'hi there',
    questions: { d: { type: 'choice', instructions: 'Which role?', criteria: { fast: 'Short', smart: 'Long', code: 'Code' } } } });
  assert.deepEqual(Object.keys(ts.questions.d.criteria), ['fast', 'smart', 'code']);
  assert.equal(reasonOf(() => toTypeSafe({ ...body, options: [...body.options, { id: 'fast', label: 'again' }] }, 'm')), 'duplicate-option');
  assert.equal(reasonOf(() => toTypeSafe({ ...body, state: null }, 'm')), 'invalid-request');
  assert.equal(reasonOf(() => toTypeSafe(body, '')), 'invalid-model');
});

test('fromTypeSafe renormalises 4-decimal probabilities so they pass the ±0.002 sum check', () => {
  // Sums to 1.0045: core would refuse it as sent.
  const raw = { fast: 0.6015, smart: 0.3015, code: 0.1015 };
  const out = fromTypeSafe(answer(raw), body, 'laya-ml');
  assert.equal(out.selected, 'fast');
  assert.equal(out.model, 'laya-ml');
  assert.equal(out.calibrated, false);
  assert.deepEqual(out.raw, raw);
  assert.ok(Math.abs(Object.values(out.scores).reduce((a, b) => a + b, 0) - 1) < 1e-12);
  assert.equal(contractProblem(body, out), null);
  assert.equal(contractProblem(body, { selected: 'fast', scores: raw }), 'score-sum');
});

test('fromTypeSafe refuses what core could not use', () => {
  assert.equal(reasonOf(() => fromTypeSafe({ answers: {} }, body, 'm')), 'no-probabilities');
  assert.equal(reasonOf(() => fromTypeSafe(answer({ fast: 0.5, smart: 0.5 }), body, 'm')), 'option-mismatch');
  assert.equal(reasonOf(() => fromTypeSafe(answer({ fast: 0.5, smart: 0.3, code: 0.1, other: 0.1 }), body, 'm')), 'option-mismatch');
  assert.equal(reasonOf(() => fromTypeSafe(answer({ fast: 0.5, smart: 0.6, code: -0.1 }), body, 'm')), 'invalid-probability');
  assert.equal(reasonOf(() => fromTypeSafe(answer({ fast: 0.5, smart: '0.5', code: 0 }), body, 'm')), 'invalid-probability');
  assert.equal(reasonOf(() => fromTypeSafe(answer({ fast: 0, smart: 0, code: 0 }), body, 'm')), 'no-mass');
  // An exact tie at the top is refused (the caller falls back), not broken by option order.
  assert.equal(reasonOf(() => fromTypeSafe(answer({ fast: 0.4, smart: 0.4, code: 0.2 }), body, 'm')), 'exact-tie');
  // A tie below the top is fine.
  assert.equal(fromTypeSafe(answer({ fast: 0.5, smart: 0.25, code: 0.25 }), body, 'm').selected, 'fast');
});

test('contractProblem agrees with core decision-endpoint choice() on every case', async () => {
  const cases = [
    { selected: 'fast', scores: { fast: 0.7, smart: 0.2, code: 0.1 } },
    { selected: 'fast', scores: { fast: 0.7, smart: 0.2, code: 0.1009 } }, // inside ±0.002
    { selected: 'fast', scores: { fast: 0.7, smart: 0.2, code: 0.103 } }, // outside
    { selected: 'smart', scores: { fast: 0.7, smart: 0.2, code: 0.1 } }, // not the argmax
    { selected: 'fast', scores: { fast: 0.4, smart: 0.4, code: 0.2 } }, // tie with another
    { selected: 'fast', scores: { fast: 0.8, smart: 0.2 } }, // a missing score
    { selected: 'other', scores: { fast: 0.7, smart: 0.2, code: 0.1 } },
    { selected: 'fast', scores: { fast: 1.2, smart: -0.1, code: -0.1 } },
  ];
  for (const result of cases) {
    const endpoint = createDecisionEndpoint({ env: { COWORK_DECISION_URL: 'http://127.0.0.1:9' },
      fetchImpl: async () => new Response(JSON.stringify({ ...result, model: 'convaiinnovations/laya', calibrated: false })) });
    let coreAccepts = true;
    try { await endpoint.choice(body); } catch (e) { assert.equal(e.reason, 'invalid-result'); coreAccepts = false; }
    assert.equal(contractProblem(body, result) === null, coreAccepts, JSON.stringify(result));
  }
});
