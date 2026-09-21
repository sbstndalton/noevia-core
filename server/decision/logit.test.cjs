'use strict';
// llama-logit measurement contract v2 (backends.cjs), against mocked llama.cpp responses only.
const test = require('node:test'), assert = require('node:assert/strict');
const { llamaLogitBackend } = require('./backends.cjs');
const { createDecisions } = require('./index.cjs');

// Token ids: "A"=10, " A"=11, "B"=20, " B"=21, "C"=30, " C"=31; "<|channel>"=1, "**"=2.
const IDS = { A: 10, ' A': 11, B: 20, ' B': 21, C: 30, ' C': 31 };
const opts = [{ id: 'keep', label: 'Keep' }, { id: 'switch', label: 'Switch' }, { id: 'ask', label: 'Ask' }];
const request = { kind: 'choice', question: 'q', context: { stateText: 's' }, options: opts };

function server({ first, biased, tokenize = (c) => [{ id: IDS[c], piece: c }] }) {
  const bodies = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body); bodies.push({ url, body });
    let out;
    if (url.endsWith('/tokenize')) out = { tokens: tokenize(body.content) };
    else if (url.endsWith('/apply-template')) out = { prompt: 'P' };
    else if (body.logit_bias) out = { completion_probabilities: [{ top_probs: biased }] };
    else out = { completion_probabilities: [{ top_logprobs: first }], timings: { prompt_n: 7 } };
    return { ok: true, json: async () => out };
  };
  return { fetchImpl, bodies };
}
const lp = (token, id, p) => ({ token, id, logprob: Math.log(p) });
const pp = (token, id, prob) => ({ token, id, prob });

test('variants of one label are summed, and ratios come from the equal-bias request', async () => {
  const s = server({ first: [lp('B', 20, 0.6), lp('A', 10, 0.3), lp(' B', 21, 0.05)],
    biased: [pp('B', 20, 0.5), pp(' B', 21, 0.1), pp('A', 10, 0.3), pp('C', 30, 0.0999)] });
  const r = await llamaLogitBackend({ baseUrl: 'http://w', fetchImpl: s.fetchImpl }).decide(request);
  assert.equal(r.selected, 'switch');
  assert.ok(Math.abs(r.metadata.probs.switch - 0.6 / 0.9999) < 1e-9);
  assert.deepEqual(r.metadata.readout.observed, ['keep', 'switch', 'ask']);
  const biasedReq = s.bodies.find((b) => b.body.logit_bias);
  assert.deepEqual(biasedReq.body.samplers, ['temperature']); assert.equal(biasedReq.body.post_sampling_probs, true);
  assert.equal(new Set(biasedReq.body.logit_bias.map(([, b]) => b)).size, 1, 'one equal bias for every label token');
});

test('a formatting or channel token at the answer position makes the readout invalid', async () => {
  const s = server({ first: [lp('<|channel>', 1, 0.9), lp('B', 20, 0.05)], biased: [pp('B', 20, 1)] });
  await assert.rejects(llamaLogitBackend({ baseUrl: 'http://w', fetchImpl: s.fetchImpl }).decide(request), /answer position holds 0.050 label mass.*channel/);
});

test('empty probabilities are invalid, never a first-option default', async () => {
  const s = server({ first: [], biased: [] });
  await assert.rejects(llamaLogitBackend({ baseUrl: 'http://w', fetchImpl: s.fetchImpl }).decide(request), /no probabilities returned/);
});

test('a label missing from the biased distribution is reported, and a large residual is invalid', async () => {
  const s = server({ first: [lp('A', 10, 0.7), lp('B', 20, 0.2)], biased: [pp('A', 10, 0.7), pp('B', 20, 0.2), pp('x', 99, 0.1)] });
  await assert.rejects(llamaLogitBackend({ baseUrl: 'http://w', fetchImpl: s.fetchImpl }).decide(request), (e) => {
    assert.match(e.message, /residual mass/); assert.deepEqual(e.readout.unobserved, ['ask']); return true;
  });
});

test('an unobserved label with a negligible residual is complete, and marked unobserved rather than invented', async () => {
  const s = server({ first: [lp('A', 10, 0.8), lp('B', 20, 0.15)], biased: [pp('A', 10, 0.8), pp('B', 20, 0.19995)] });
  const r = await llamaLogitBackend({ baseUrl: 'http://w', fetchImpl: s.fetchImpl }).decide(request);
  assert.equal(r.selected, 'keep'); assert.deepEqual(r.metadata.readout.unobserved, ['ask']); assert.equal(r.metadata.probs.ask, 0);
});

test('an exact tie is invalid', async () => {
  const s = server({ first: [lp('A', 10, 0.45), lp('B', 20, 0.45)], biased: [pp('A', 10, 0.5), pp('B', 20, 0.5)] });
  await assert.rejects(llamaLogitBackend({ baseUrl: 'http://w', fetchImpl: s.fetchImpl }).decide(request), /exact tie/);
});

test('a label that is not a single token is refused', async () => {
  const s = server({ first: [], biased: [], tokenize: (c) => (c.trim() === 'B' ? [{ id: 1, piece: '(' }, { id: 2, piece: 'B' }] : [{ id: IDS[c], piece: c }]) });
  await assert.rejects(llamaLogitBackend({ baseUrl: 'http://w', fetchImpl: s.fetchImpl }).decide(request), /label B is not a single token/);
});

test('through decide(), an invalid readout uses the authorised fallback and is logged', async () => {
  const s = server({ first: [lp('**', 2, 0.99)], biased: [] });
  const logs = [];
  const d = createDecisions({ backends: { 'llama-logit': llamaLogitBackend({ baseUrl: 'http://w', fetchImpl: s.fetchImpl }) }, chains: { p: ['llama-logit'] }, log: (e) => logs.push(e) });
  const r = await d.decide({ ...request, purpose: 'p', fallback: { selected: 'keep', scores: {}, confidence: null }, constraints: { deadlineMs: 1000 } });
  assert.equal(r.source, 'fallback'); assert.equal(r.selected, 'keep');
  assert.ok(logs.some((e) => /readout invalid/.test(e.failed || '')));
});
