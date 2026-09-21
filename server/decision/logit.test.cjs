'use strict';
// llama-logit readout contract v3 (backends.cjs), against mocked llama.cpp responses only.
const test = require('node:test'), assert = require('node:assert/strict');
const { llamaLogitBackend } = require('./backends.cjs');
const { createDecisions } = require('./index.cjs');

// Token ids: "A"=10, " A"=11, "B"=20, " B"=21, "C"=30, " C"=31; "<|channel>"=1, "**"=2.
const IDS = { A: 10, ' A': 11, B: 20, ' B': 21, C: 30, ' C': 31 };
const opts = [{ id: 'keep', label: 'Keep' }, { id: 'switch', label: 'Switch' }, { id: 'ask', label: 'Ask' }];
const request = { kind: 'choice', question: 'q', context: { stateText: 'PRIVATE-STATE-TEXT' }, options: opts };

function server({ first, biased, tokenize = (c) => [{ id: IDS[c], piece: c }] }) {
  const bodies = [];
  const fetchImpl = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null; bodies.push({ url, body });
    let out;
    if (url.endsWith('/props')) out = { model_path: '/m/test.gguf', build_info: 'b1-test', default_generation_settings: { n_ctx: 8192 } };
    else if (url.endsWith('/tokenize')) out = { tokens: tokenize(body.content) };
    else if (url.endsWith('/apply-template')) out = { prompt: 'P' };
    else if (body.logit_bias) out = { completion_probabilities: [{ top_probs: biased }] };
    else out = { completion_probabilities: [{ top_logprobs: first }], timings: { prompt_n: 7, prompt_ms: 3 } };
    return { ok: true, json: async () => out };
  };
  return { fetchImpl, bodies };
}
const lp = (token, id, p) => ({ token, id, logprob: Math.log(p) });
const pp = (token, id, prob) => ({ token, id, prob });
const all = (pA, pB, pC) => [pp('A', 10, pA * 0.9), pp(' A', 11, pA * 0.1), pp('B', 20, pB * 0.9), pp(' B', 21, pB * 0.1), pp('C', 30, pC * 0.9), pp(' C', 31, pC * 0.1)];
const backend = (s, extra = {}) => llamaLogitBackend({ baseUrl: 'http://w', fetchImpl: s.fetchImpl, ...extra });

test('exact: every permitted token observed; variants summed; ratios from the equal-bias request', async () => {
  const s = server({ first: [lp('B', 20, 0.6), lp('A', 10, 0.3)], biased: all(0.3, 0.6, 0.1) });
  const r = await backend(s).decide(request);
  assert.equal(r.selected, 'switch'); assert.equal(r.metadata.readout, 'exact'); assert.equal(r.metadata.calibrated, false);
  assert.ok(Math.abs(r.metadata.ratios.switch - 0.6) < 1e-9);
  const b2 = s.bodies.find((b) => b.body?.logit_bias);
  assert.deepEqual(b2.body.samplers, ['temperature']); assert.equal(b2.body.post_sampling_probs, true);
  assert.equal(new Set(b2.body.logit_bias.map(([, v]) => v)).size, 1, 'one equal bias');
});

test('bounded: an unobserved label is absent from the scores and carries an interval, not a measured zero', async () => {
  const s = server({ first: [lp('A', 10, 0.8), lp('B', 20, 0.15)], biased: [pp('A', 10, 0.7), pp(' A', 11, 0.1), pp('B', 20, 0.15), pp(' B', 21, 0.04995)] });
  const r = await backend(s).decide(request);
  assert.equal(r.metadata.readout, 'bounded'); assert.equal(r.selected, 'keep');
  assert.equal('ask' in r.scores, false); assert.equal('ask' in r.metadata.ratios, false);
  assert.equal(r.metadata.bounds.ask[0], 0); assert.ok(r.metadata.bounds.ask[1] > 0);
  assert.deepEqual(r.metadata.diagnostics.unobserved, ['ask']);
  assert.deepEqual(r.metadata.diagnostics.unobservedVariants.map((v) => v.id).sort(), [30, 31]);
});

test('bounded: a choice that an unobserved token could overturn is rejected', async () => {
  const s = server({ first: [lp('A', 10, 0.5), lp('B', 20, 0.45)], biased: [pp('A', 10, 0.4999), pp('B', 20, 0.4995)] });
  await assert.rejects(backend(s, { maxResidual: 1e-2 }).decide(request), /not robust to unobserved-token bound/);
});

test('an unsupported (multi-token) variant is recorded; a multi-token canonical label is refused', async () => {
  const ok = server({ first: [lp('A', 10, 0.9)], biased: [pp('A', 10, 0.9), pp('B', 20, 0.05), pp(' B', 21, 0.01), pp('C', 30, 0.03), pp(' C', 31, 0.01)],
    tokenize: (c) => (c === ' A' ? [{ id: 5, piece: ' ' }, { id: 10, piece: 'A' }] : [{ id: IDS[c], piece: c }]) });
  const r = await backend(ok).decide(request);
  assert.deepEqual(r.metadata.diagnostics.unsupportedVariants, [{ option: 'keep', text: ' A' }]);
  const bad = server({ first: [], biased: [], tokenize: (c) => (c.trim() === 'B' ? [{ id: 1, piece: '(' }, { id: 2, piece: 'B' }] : [{ id: IDS[c], piece: c }]) });
  await assert.rejects(backend(bad).decide(request), /label B is not a single token/);
});

test('invalid readouts throw with diagnostics: formatting token, empty, residual, tie', async () => {
  const cases = [
    [{ first: [lp('<|channel>', 1, 0.9), lp('B', 20, 0.05)], biased: all(0.3, 0.6, 0.1) }, /answer position holds 0.050 label mass < 0.5 \(top token "<\|channel>"\)/],
    [{ first: [], biased: [] }, /no probabilities returned \(request 1\)/],
    [{ first: [lp('A', 10, 0.7)], biased: [pp('A', 10, 0.7), pp('B', 20, 0.2), pp('x', 99, 0.1)] }, /residual mass/],
    [{ first: [lp('A', 10, 0.45), lp('B', 20, 0.45)], biased: [pp('A', 10, 0.5), pp('B', 20, 0.5)] }, /exact tie/],
  ];
  for (const [srv, re] of cases) {
    await assert.rejects(backend(server(srv)).decide(request), (e) => {
      assert.match(e.message, re); assert.equal(e.diagnostics.readout, 'invalid'); assert.match(e.diagnostics.rejection, re);
      assert.equal(e.diagnostics.runtime.build, 'b1-test'); assert.ok(e.diagnostics.labels.keep.variants.length === 2);
      assert.equal(typeof e.diagnostics.timings.totalMs, 'number');
      return true;
    });
  }
});

test('diagnostics never contain the prompt or state text', async () => {
  const s = server({ first: [lp('<|channel>', 1, 0.99)], biased: [] });
  await assert.rejects(backend(s).decide(request), (e) => { assert.equal(JSON.stringify(e.diagnostics).includes('PRIVATE-STATE-TEXT'), false); return true; });
});

test('through decide(): a failure falls back, and its diagnostics reach the opt-in hook intact', async () => {
  const s = server({ first: [lp('**', 2, 0.99)], biased: [] });
  const seen = [];
  const d = createDecisions({ backends: { 'llama-logit': backend(s) }, chains: { p: ['llama-logit'] }, onDiagnostic: (e) => seen.push(e) });
  const r = await d.decide({ ...request, purpose: 'p', fallback: { selected: 'keep', scores: {}, confidence: null }, constraints: { deadlineMs: 1000 } });
  assert.equal(r.source, 'fallback'); assert.equal(r.selected, 'keep');
  assert.equal(seen.length, 1); assert.equal(seen[0].ok, false);
  assert.match(seen[0].reason, /answer position holds/);
  assert.equal(seen[0].diagnostics.request1.top[0].token, '**');
});

test('without the hook, decide() records nothing beyond its usual short log line', async () => {
  const s = server({ first: [lp('**', 2, 0.99)], biased: [] });
  const logs = [];
  const d = createDecisions({ backends: { 'llama-logit': backend(s) }, chains: { p: ['llama-logit'] }, log: (e) => logs.push(e) });
  await d.decide({ ...request, purpose: 'p', fallback: { selected: 'keep', scores: {}, confidence: null }, constraints: { deadlineMs: 1000 } });
  assert.ok(logs.every((e) => !('diagnostics' in e)));
});
