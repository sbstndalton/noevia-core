'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { PRESETS, classifyTaskForSampling, selectSamplingParams, sanitizeExplicitSampling, validSamplingValue } = require('./sampling-presets.cjs');

test('classifies coding from the router code role', () => {
  assert.equal(classifyTaskForSampling({ routedRole: 'code', message: 'fix this function' }), 'coding');
});
test('classifies reasoning from the router smart role', () => {
  assert.equal(classifyTaskForSampling({ routedRole: 'smart', message: 'explain the tradeoffs of X vs Y' }), 'reasoning');
});
test('classifies general from the router fast role', () => {
  assert.equal(classifyTaskForSampling({ routedRole: 'fast', message: 'hi' }), 'general');
});
test('classifies creative from a cheap heuristic on the prompt even under a fast/smart role', () => {
  assert.equal(classifyTaskForSampling({ routedRole: 'fast', message: 'Write a short story about a lighthouse keeper.' }), 'creative');
  assert.equal(classifyTaskForSampling({ routedRole: 'smart', message: 'Compose a poem about autumn.' }), 'creative');
});
test('the creative heuristic never overrides an explicit code classification', () => {
  assert.equal(classifyTaskForSampling({ routedRole: 'code', message: 'write a story generator function' }), 'coding');
});
test('no role and no heuristic match falls back to general', () => {
  assert.equal(classifyTaskForSampling({ routedRole: null, message: 'what time is it' }), 'general');
});

test('preset values are consistent with the documented set (issue #194)', () => {
  assert.deepEqual(PRESETS.general, {});
  assert.deepEqual(PRESETS.coding, { temperature: 0.2, top_p: 0.9, repeat_penalty: 1.05 });
  assert.deepEqual(PRESETS.creative, { temperature: 0.9, top_p: 0.95 });
  assert.deepEqual(PRESETS.reasoning, { temperature: 0.5 });
});

test('selectSamplingParams applies the auto preset by default', () => {
  const r = selectSamplingParams({ routedRole: 'code', message: 'write a function' });
  assert.deepEqual(r.params, { temperature: 0.2, top_p: 0.9, repeat_penalty: 1.05 });
  assert.equal(r.presetId, 'coding'); assert.equal(r.source, 'auto');
});

test('selectSamplingParams sends nothing for general (current defaults, no override)', () => {
  const r = selectSamplingParams({ routedRole: 'fast', message: 'hi' });
  assert.deepEqual(r.params, {});
  assert.equal(r.presetId, 'general'); assert.equal(r.source, 'none');
});

test('explicit sampling values take precedence over the auto preset, per key', () => {
  const r = selectSamplingParams({ routedRole: 'code', message: 'write code', explicit: { temperature: 0.7 } });
  assert.deepEqual(r.params, { temperature: 0.7, top_p: 0.9, repeat_penalty: 1.05 });
  assert.equal(r.presetId, 'coding'); assert.equal(r.source, 'auto');
});

test('fully explicit sampling values report source explicit even though a preset would apply', () => {
  const r = selectSamplingParams({ routedRole: 'reasoning', explicit: { temperature: 0.33 }, message: '' });
  assert.deepEqual(r.params, { temperature: 0.33 });
  assert.equal(r.source, 'explicit');
});

test('turning automatic sampling presets off applies only explicit values, never a preset', () => {
  const r = selectSamplingParams({ routedRole: 'code', message: 'write a function', explicit: { temperature: 0.7 }, autoEnabled: false });
  assert.deepEqual(r.params, { temperature: 0.7 });
  assert.equal(r.presetId, null); assert.equal(r.source, 'explicit');
});

test('turning automatic sampling presets off with no explicit values sends nothing (documented fallback)', () => {
  const r = selectSamplingParams({ routedRole: 'code', message: 'write a function', autoEnabled: false });
  assert.deepEqual(r.params, {});
  assert.equal(r.presetId, null); assert.equal(r.source, 'none');
});

test('sanitizeExplicitSampling drops out-of-range or wrongly typed values', () => {
  assert.deepEqual(sanitizeExplicitSampling({ temperature: 'hot', top_p: 0.5, top_k: -1, repeat_penalty: 1.1 }), { top_p: 0.5, repeat_penalty: 1.1 });
  assert.equal(sanitizeExplicitSampling(null), undefined);
  assert.equal(sanitizeExplicitSampling({}), undefined);
  assert.equal(sanitizeExplicitSampling({ temperature: 5 }), undefined); // out of range
});

test('sanitizeExplicitSampling ignores unknown keys', () => {
  assert.deepEqual(sanitizeExplicitSampling({ temperature: 0.4, mirostat: 2 }), { temperature: 0.4 });
});

test('validSamplingValue bounds each key', () => {
  assert.equal(validSamplingValue('temperature', 0), true);
  assert.equal(validSamplingValue('temperature', 2), true);
  assert.equal(validSamplingValue('temperature', 2.01), false);
  assert.equal(validSamplingValue('top_p', 0), false); // must be > 0
  assert.equal(validSamplingValue('top_p', 1), true);
  assert.equal(validSamplingValue('top_k', 3.5), false);
  assert.equal(validSamplingValue('repeat_penalty', 3.5), false);
});
