'use strict';
// #1639: per-purpose decision routing. Kev-0.8B serves route, tool gate, supervision, framing and the
// load advisor; the sensitivity check stays on Laya-en (#1647: Kev is not qualified) through
// COWORK_SENSITIVITY_DECISION_URL. Unset, everything is as before #1639. Synthetic requests only.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDecisionSettings } = require('./decision-settings.cjs');

const KEV = 'http://kev:11435';
const LAYA = 'http://laya:8040';
const memory = (saved) => { const m = new Map(saved ? [['decision:configuration', JSON.stringify(saved)]] : []); return { get: (k) => m.get(k), set: (k, v) => m.set(k, v) }; };
function recorder() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, headers: init.headers, redirect: init.redirect });
    if (body.questions) return Response.json({ answers: { d: { probabilities: { sensitive: 0.3, not_sensitive: 0.7 } } } });
    return Response.json({ selected: 'not_sensitive', scores: { sensitive: 0.3, not_sensitive: 0.7 }, model: 'convaiinnovations/laya' });
  };
  return { calls, fetchImpl };
}
const request = (purpose) => ({ kind: 'choice', purpose, question: 'Synthetic question?', context: { stateText: 'synthetic text' },
  options: [{ id: 'sensitive', label: 'Sensitive' }, { id: 'not_sensitive', label: 'Not sensitive' }] });

test('override unset: sensitivity uses the shared backend, exactly as before #1639', async () => {
  for (const extra of [{}, { COWORK_SENSITIVITY_DECISION_URL: '' }, { COWORK_SENSITIVITY_DECISION_URL: '  ' }]) {
    const { calls, fetchImpl } = recorder();
    const settings = createDecisionSettings({ store: memory(), env: { COWORK_DECISION_URL: LAYA, ...extra }, fetchImpl });
    assert.equal(settings.sensitivityBackend(), settings.backend());
    assert.equal(settings.backend().wording, 'laya');
    await settings.sensitivityBackend().decide(request('routing.sensitivity'));
    assert.deepEqual(calls.map((c) => c.url), [`${LAYA}/v1/decisions`]);
    assert.deepEqual(Object.keys(calls[0].body), ['state', 'question', 'options']);
  }
});

test('override set: sensitivity requests go only to that URL, on Laya wording and contract; the rest go to Kev', async () => {
  const { calls, fetchImpl } = recorder();
  const settings = createDecisionSettings({ store: memory(), fetchImpl, env: { COWORK_DECISION_URL: KEV, COWORK_DECISION_MODEL: 'kev-0.8b',
    COWORK_DECISION_API_KEY: 'synthetic-key', COWORK_SENSITIVITY_DECISION_URL: LAYA } });
  const shared = settings.backend(), sensitivity = settings.sensitivityBackend();
  assert.notEqual(shared, sensitivity);
  assert.deepEqual([shared.model, shared.wording, sensitivity.model, sensitivity.wording], ['kev-0.8b', 'kev', 'laya', 'laya']);
  await sensitivity.decide(request('routing.sensitivity'));
  await shared.decide(request('tool.gate'));
  await shared.supervise({ goal: 'synthetic', outputs: [{ role: 'tool', content: 'r' }] }).catch(() => {}); // options differ from the stub: refused, still sent
  assert.equal(calls[0].url, `${LAYA}/v1/decisions`);
  assert.deepEqual(Object.keys(calls[0].body), ['state', 'question', 'options']);
  assert.deepEqual(calls[0].headers, { 'Content-Type': 'application/json' }, 'the Kev key never goes to Laya');
  assert.ok(calls.slice(1).every((c) => c.url === `${KEV}/v1/decisions` && c.body.model === 'ollaya.dev/library/kev:0.8b'));
  assert.equal(calls[2].body.questions.d.instructions, 'What should the assistant do next with these tool results?');
  assert.equal(calls.filter((c) => c.url.startsWith(LAYA)).length, 1, 'only the sensitivity request reached Laya');
  assert.ok(calls.every((c) => c.redirect === 'error'));
});

test('per-model T: Kev scores are tempered at 0.45, Laya scores are not', async () => {
  const { fetchImpl } = recorder();
  const settings = createDecisionSettings({ store: memory(), fetchImpl, env: { COWORK_DECISION_URL: KEV, COWORK_DECISION_MODEL: 'kev-0.8b', COWORK_SENSITIVITY_DECISION_URL: LAYA } });
  const kev = await settings.backend().decide(request('tool.gate'));
  const laya = await settings.sensitivityBackend().decide(request('routing.sensitivity'));
  const a = 0.3 ** (1 / 0.45), b = 0.7 ** (1 / 0.45);
  assert.ok(Math.abs(kev.scores.not_sensitive - b / (a + b)) < 1e-12);
  assert.deepEqual(laya.scores, { sensitive: 0.3, not_sensitive: 0.7 });
  assert.equal(laya.metadata.model, 'convaiinnovations/laya');
});

test('a set override that is not a private decision-service URL disables sensitivity; it never falls back to the shared service', () => {
  for (const url of ['https://cloud.example.com', 'http://203.0.113.7:8040', 'http://laya:8040/path', 'http://user:pw@laya:8040', 'garbage']) {
    const settings = createDecisionSettings({ store: memory(), env: { COWORK_DECISION_URL: KEV, COWORK_DECISION_MODEL: 'kev-0.8b', COWORK_SENSITIVITY_DECISION_URL: url } });
    assert.ok(settings.backend(), url);
    assert.equal(settings.sensitivityBackend(), null, url);
  }
});

test('the sensitivity model defaults to Laya even when the shared one is Kev; it can be named explicitly', () => {
  const env = { COWORK_DECISION_URL: KEV, COWORK_DECISION_MODEL: 'kev-0.8b', COWORK_SENSITIVITY_DECISION_URL: LAYA };
  assert.equal(createDecisionSettings({ store: memory(), env }).sensitivityBackend().wording, 'laya');
  assert.equal(createDecisionSettings({ store: memory(), env: { ...env, COWORK_SENSITIVITY_DECISION_MODEL: 'laya' } }).sensitivityBackend().model, 'laya');
});

test('the model belongs to COWORK_DECISION_URL: an admin-saved other URL gets the Laya profile', () => {
  const env = { COWORK_DECISION_URL: KEV, COWORK_DECISION_MODEL: 'kev-0.8b' };
  assert.equal(createDecisionSettings({ store: memory(), env }).backend().wording, 'kev');
  assert.equal(createDecisionSettings({ store: memory({ url: KEV, timeoutMs: 1500 }), env }).backend().wording, 'kev', 'saved, same URL');
  assert.equal(createDecisionSettings({ store: memory({ url: LAYA, timeoutMs: 1500 }), env }).backend().wording, 'laya', 'saved, Laya URL');
  assert.equal(createDecisionSettings({ store: memory(), env: { COWORK_DECISION_URL: LAYA, COWORK_DECISION_MODEL: 'something-new' } }).backend().wording, 'laya', 'unknown model');
});

test('the backend object is stable between calls, so the callers keep their decision layers', () => {
  const settings = createDecisionSettings({ store: memory(), env: { COWORK_DECISION_URL: KEV, COWORK_DECISION_MODEL: 'kev-0.8b', COWORK_SENSITIVITY_DECISION_URL: LAYA } });
  assert.equal(settings.backend(), settings.backend());
  assert.equal(settings.sensitivityBackend(), settings.sensitivityBackend());
});
