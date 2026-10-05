'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { WORKLOADS, SPEC_CANDIDATES, geomean } = require('./llamacpp-tune-spec.cjs');

test('geomean ignores non-positive samples and is 0 for none', () => {
  assert.ok(Math.abs(geomean([10, 40]) - 20) < 1e-9);
  assert.ok(Math.abs(geomean([10, 0, -3, 40]) - 20) < 1e-9);
  assert.equal(geomean([]), 0);
});

test('the baseline candidate is first and every candidate sets the three speculative keys', () => {
  assert.equal(SPEC_CANDIDATES[0].id, 'off');
  assert.deepEqual(SPEC_CANDIDATES.map((c) => c.id), ['off', 'mtp', 'mtp-deep', 'mtp-shallow', 'ngram']);
  for (const c of SPEC_CANDIDATES) assert.deepEqual(Object.keys(c.options), ['spec-type', 'spec-draft-n-max', 'spec-draft-p-min']);
  assert.deepEqual(WORKLOADS.map((w) => w.id), ['list', 'prose', 'code']);
});
