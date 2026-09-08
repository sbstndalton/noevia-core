'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const prefill = require('./prefill.cjs');

// This replaces a regex on the model's FILENAME as the way noevia decides how
// many tools a model can carry. The tests are mostly about the ways a passive
// measurement can be lied to, because that is the whole risk of measuring real
// traffic instead of running a controlled probe.

test.beforeEach(() => prefill.reset());

test('fits the prefill rate from real observations', () => {
  // 360 tok/s (0.36 tok/ms) with 500 ms of fixed per-request overhead. The
  // overhead must cancel: the budget question is the marginal cost of another
  // tool token, not the intercept.
  for (const t of [17, 924, 1500, 4161]) prefill.recordSample('m', t, 500 + t / 0.36);
  assert.equal(Math.round(prefill.rateFor('m') * 1000), 360);
  assert.equal(prefill.budgetFor('m', 14000), 5040);
});

test('a cold-start sample does not drag the fit', () => {
  // The contamination that makes averaging useless: Lemonade runs
  // max_loaded_models=1, so the first request after a model swap includes many
  // seconds of LOAD time that has nothing to do with prefill.
  prefill.recordSample('m', 500, 500 + 500 / 0.36);
  prefill.recordSample('m', 4000, 30000); // cold: 30 s, model was being loaded
  const contaminated = prefill.rateFor('m');
  // Now a warm observation at the same size arrives.
  prefill.recordSample('m', 4000, 500 + 4000 / 0.36);
  const clean = prefill.rateFor('m');
  assert.ok(clean > contaminated, 'the warm sample should replace the cold one');
  assert.equal(Math.round(clean * 1000), 360);
});

test('the lower envelope never gets worse', () => {
  prefill.recordSample('m', 2000, 3000);
  prefill.recordSample('m', 2000, 9000); // slower at the same size: ignored
  prefill.recordSample('m', 500, 1200);
  const first = prefill.rateFor('m');
  prefill.recordSample('m', 2000, 12000);
  assert.equal(prefill.rateFor('m'), first);
});

test('too narrow a range of prompt sizes yields no rate', () => {
  // Everything the same size tells you nothing about the slope, so it must
  // report "unmeasured" rather than fitting noise.
  prefill.recordSample('m', 1000, 3000);
  prefill.recordSample('m', 1100, 3100);
  assert.equal(prefill.rateFor('m'), null);
  assert.equal(prefill.budgetFor('m', 14000), null);
});

test('a single observation is never enough', () => {
  prefill.recordSample('m', 4000, 12000);
  assert.equal(prefill.rateFor('m'), null);
});

test('a bigger prompt that came back faster is noise, not signal', () => {
  // Queueing or a warm cache can invert two samples. A negative slope would
  // otherwise produce a negative budget.
  prefill.recordSample('m', 500, 9000);
  prefill.recordSample('m', 4000, 3000);
  assert.equal(prefill.rateFor('m'), null);
});

test('junk observations are refused outright', () => {
  for (const [t, ms] of [[0, 100], [-5, 100], [100, 0], [100, -1], [100, 999999], [NaN, 100], [100, NaN]]) {
    prefill.recordSample('m', t, ms);
  }
  prefill.recordSample('', 1000, 1000);
  prefill.recordSample(null, 1000, 1000);
  assert.deepEqual(prefill.stats(), {});
});

test('models are measured independently', () => {
  for (const t of [500, 4000]) prefill.recordSample('fast', t, 100 + t / 2.0);
  for (const t of [500, 4000]) prefill.recordSample('slow', t, 100 + t / 0.2);
  assert.ok(prefill.rateFor('fast') > prefill.rateFor('slow') * 5);
  assert.equal(Object.keys(prefill.stats()).length, 2);
});

test('memory per model is bounded', () => {
  for (let i = 1; i <= 200; i++) prefill.recordSample('m', i * 250, i * 100);
  assert.ok(prefill.stats().m.buckets <= 32, `unbounded: ${prefill.stats().m.buckets}`);
});

test('the budget follows the measured rate, and a faster model earns more', () => {
  for (const t of [500, 5000]) prefill.recordSample('slow', t, t / 0.36);
  for (const t of [500, 5000]) prefill.recordSample('quick', t, t / 3.6);
  assert.ok(prefill.budgetFor('quick', 14000) > prefill.budgetFor('slow', 14000) * 5);
});

test('the budget is clamped so one freak measurement cannot run away', () => {
  const { toolTokenBudgetFor } = require('./index.cjs');
  prefill.reset();
  // Absurdly fast: would imply a ~200k-token budget without the clamp.
  for (const t of [500, 5000]) prefill.recordSample('freak', t, t / 20);
  assert.ok(toolTokenBudgetFor('freak') <= 16000);
  prefill.reset();
  // Absurdly slow: would imply a budget of a few dozen tokens.
  for (const t of [500, 5000]) prefill.recordSample('crawl', t, t * 20);
  assert.ok(toolTokenBudgetFor('crawl') >= 1500);
});

test('an unmeasured model falls back to the filename heuristic', () => {
  const { toolTokenBudgetFor } = require('./index.cjs');
  prefill.reset();
  assert.equal(toolTokenBudgetFor('Qwen3.5-9B-GGUF'), 5000);
  assert.equal(toolTokenBudgetFor('claude-sonnet-4-5'), 8000);
});
