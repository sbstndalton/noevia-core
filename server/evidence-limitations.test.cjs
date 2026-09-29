'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { limitationKeys, LIMITATION_IDS } = require('./evidence-limitations.cjs');

test('every sentence the server records maps to a stable id, in order', () => {
  const keys = limitationKeys([
    'Three deterministic quality smoke probes, not a general quality benchmark',
    '120 s default prompt budget; existing MTP head only',
    '1×1 image accepted; not an accuracy test',
    'single reply; depends on content',
    'prompt budget 90 s',
    'median of 5 warm, uncontended requests; depends on prompt mix and max tokens',
    'unverified, from source: published by the model repository, not measured locally',
  ]);
  assert.deepEqual(keys.map((k) => k.id), ['autotune-quality', 'autotune-budget', 'vision-probe', 'single-reply', 'calibration-budget', 'benchmark-median', 'source-unverified']);
  assert.deepEqual(keys[4].params, { seconds: 90 });
  assert.deepEqual(keys[5].params, { n: 5 });
});

test('unknown text, non-strings and non-arrays yield null, never a guess', () => {
  assert.deepEqual(limitationKeys(['The engine ran out of memory', 3, null]), [null, null, null]);
  assert.deepEqual(limitationKeys(undefined), []);
});

test('the ids are unique', () => {
  assert.equal(new Set(LIMITATION_IDS).size, LIMITATION_IDS.length);
});

test('the sentences written by the recording code still match their patterns', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = ['llamacpp-manager.cjs', 'chat.cjs', 'benchmark-evidence.cjs', 'model-evidence-import.cjs']
    .map((f) => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n');
  for (const sentence of ['Three deterministic quality smoke probes, not a general quality benchmark', '120 s default prompt budget; existing MTP head only', '1×1 image accepted; not an accuracy test', 'single reply; depends on content', 'median of ${ok.length} warm, uncontended requests; depends on prompt mix and max tokens', 'unverified, from source: published by the model repository, not measured locally']) {
    assert.ok(source.includes(sentence), `recording code no longer writes: ${sentence}`);
  }
});
