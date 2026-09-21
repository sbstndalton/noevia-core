'use strict';
// Pure mocked responses. No HTTP listener, model, inference, or dependencies.
const test = require('node:test'), assert = require('node:assert/strict');
const { llamaLogitBackend } = require('./backends.cjs');
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-10, `${a} != ${b}`);
const entry = (id, prob) => ({ id, token: `t${id}`, prob });

async function score(top, count = 2) {
  const fetchImpl = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : {};
    let data;
    if (url.endsWith('/props')) data = { model_path: 'synthetic', build_info: 'mock', default_generation_settings: { n_ctx: 8192 } };
    else if (url.endsWith('/tokenize')) data = { tokens: [{ id: 100 + (body.content.trim().charCodeAt(0) - 65) * 2 + Number(body.content.startsWith(' ')) }] };
    else if (url.endsWith('/apply-template')) data = { prompt: 'synthetic prompt' };
    else if (body.logit_bias) data = { completion_probabilities: [{ top_probs: top }] };
    else data = { completion_probabilities: [{ top_logprobs: [{ id: 100, token: 'A', logprob: Math.log(0.9) }] }] };
    return { ok: true, json: async () => data };
  };
  const options = Array.from({ length: count }, (_, i) => ({ id: String.fromCharCode(65 + i), label: `option ${i}` }));
  return llamaLogitBackend({ baseUrl: 'http://mock', fetchImpl }).decide({ kind: 'choice', question: 'synthetic', options });
}

test('fully observed label distribution has point bounds even with non-label residual', async () => {
  const r = await score([entry(100, 0.4), entry(101, 0.2), entry(102, 0.3), entry(103, 0.0995)]);
  assert.equal(r.metadata.readout, 'exact');
  near(r.metadata.bounds.A[0], 0.6 / 0.9995);
  near(r.metadata.bounds.A[1], 0.6 / 0.9995);
  assert.equal(r.metadata.calibrated, false);
});

test('regression: missing competitor mass can lower A below its observed-normalized ratio', async () => {
  const r = await score([entry(100, 0.6), entry(101, 0), entry(102, 0.3995)]);
  assert.equal(r.metadata.readout, 'bounded');
  near(r.metadata.bounds.A[0], 0.6);
  near(r.metadata.bounds.A[1], 0.6 / 0.9995);
  near(r.metadata.bounds.B[0], 0.3995 / 0.9995);
  near(r.metadata.bounds.B[1], 0.4);
  assert.ok(r.metadata.ratios.A > r.metadata.bounds.A[0]);
});

test('missing own variant increases its upper bound with denominator growth', async () => {
  const r = await score([entry(100, 0.6), entry(102, 0.2), entry(103, 0.1995)]);
  near(r.metadata.bounds.A[0], 0.6 / 0.9995);
  near(r.metadata.bounds.A[1], 0.6005);
  near(r.metadata.bounds.B[0], 0.3995);
});

test('wholly unobserved option is absent from scores and has a normalized interval', async () => {
  const r = await score([entry(100, 0.7), entry(101, 0), entry(102, 0.2995), entry(103, 0)], 3);
  assert.equal(Object.hasOwn(r.scores, 'C'), false);
  near(r.metadata.bounds.C[0], 0); near(r.metadata.bounds.C[1], 0.0005);
  near(r.metadata.bounds.A[0], 0.7);
});

test('bounds enclose feasible allocations for every missing-variant pattern', async () => {
  // Enumerate a grid of allocations, including unused residual (non-label mass).
  for (let mask = 1; mask < 8; mask++) {
    const masses = [0.7, 0.2, 0.0995], top = [];
    for (let i = 0; i < 3; i++) {
      top.push(entry(100 + i * 2, masses[i]));
      if (!(mask & (1 << i))) top.push(entry(101 + i * 2, 0));
    }
    const r = await score(top, 3), residual = r.metadata.diagnostics.residual;
    for (let a = 0; a <= 5; a++) for (let b = 0; b <= 5 - a; b++) for (let c = 0; c <= 5 - a - b; c++) {
      const amounts = [a, b, c].map((n, i) => mask & (1 << i) ? n * residual / 5 : 0);
      const denominator = masses.reduce((x, y) => x + y, 0) + amounts.reduce((x, y) => x + y, 0);
      for (let i = 0; i < 3; i++) {
        const p = (masses[i] + amounts[i]) / denominator;
        const [low, high] = r.metadata.bounds[String.fromCharCode(65 + i)];
        assert.ok(p >= low - 1e-12 && p <= high + 1e-12);
      }
    }
  }
});

test('a choice that missing mass could overturn is invalid', async () => {
  await assert.rejects(score([entry(100, 0.49995), entry(101, 0), entry(102, 0.49985)]), /not robust/);
});

test('an exact tie remains invalid', async () => {
  await assert.rejects(score([entry(100, 0.25), entry(101, 0.25), entry(102, 0.25), entry(103, 0.25)]), /exact tie/);
});

for (const [name, top, expected] of [
  ['nonfinite', [entry(100, NaN)], /invalid token probability/],
  ['negative', [entry(100, -0.2)], /invalid token probability/],
  ['over-one', [entry(100, 1.2)], /invalid token probability/],
  ['duplicate', [entry(100, 0.6), entry(100, 0.4)], /duplicate token/],
  ['total-over-one', [entry(100, 0.6), entry(102, 0.5)], /mass exceeds one/],
]) test(`rejects ${name} probabilities with diagnostics`, async () => {
  await assert.rejects(score(top), (error) => {
    assert.match(error.message, expected);
    assert.equal(error.diagnostics.readout, 'invalid');
    assert.equal(error.diagnostics.contract, 'equal-bias-v4');
    return true;
  });
});
