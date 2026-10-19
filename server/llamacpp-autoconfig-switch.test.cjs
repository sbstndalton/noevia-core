'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ac = require('./llamacpp-autoconfig.cjs');
const native = require('./dav-parse-wasm.cjs');
const oracle = require('../tests/reference/llamacpp-autoconfig-js.cjs');
const GIB = 1024 ** 3;
const META = { arch: 'llama', contextLength: 8192, embeddingLength: 4096, blockCount: 32, headCount: 32, headCountKv: 8, hasChatTemplate: true };
const SUGGEST = { meta: META, modelBytes: 5.56 * GIB, budgetGib: 14 };
const INPUTS = { meta: META, modelBytes: 5.5 * GIB, current: { 'ctx-size': '16384', 'cache-type-k': 'q8_0' } };
const FOOT = { meta: META, modelBytes: 5.56 * GIB, model: 'chat-model', options: { 'ctx-size': '8192', 'cache-ram': '1024' } };
const capture = fn => { try { return { value: fn() }; } catch (error) { return { error }; } };
const strictRefuses = () => ({ llamacppAutoconfig(op, args) {
  if (op <= 3) throw Object.assign(new Error('synthetic strict refusal'), { reason: 'ambiguous' });
  return native.llamacppAutoconfig(op, args);
} });
test('suggest returns only a Rust-program answer or its refusal', () => {
  assert.deepEqual(ac.suggest(SUGGEST), oracle.suggestJs(SUGGEST));
  const result = ac.suggest(SUGGEST, { wasmLoader: strictRefuses });
  assert.equal(result.code, 'autoconfig_impl');
  assert.equal(result.unverified, 'impl_refused');
  assert.equal(result.values, undefined);
});
test('panels preserve the established 503 error when strict confirmation is absent', () => {
  for (const [fn, args, what] of [[ac.estimateInputs, INPUTS, 'Will it fit?'], [ac.estimateFootprint, FOOT, 'load footprint']]) {
    const got = capture(() => fn(args, { wasmLoader: strictRefuses }));
    assert.equal(got.error.code, 'autoconfig_impl');
    assert.equal(got.error.status, 503);
    assert.equal(got.error.message, 'the memory estimate (' + what + ') could not be confirmed by the Rust sizing port, and the JS estimate is not the larger one.');
  }
});
test('Rust keeps an unbounded conservative answer when only the strict port refuses', () => {
  const args = { ...FOOT, options: { 'cache-ram': '-1' } };
  assert.deepEqual(ac.estimateFootprint(args, { wasmLoader: strictRefuses }), oracle.estimateFootprintJs(args));
});
test('missing or faulty native policy modules fail closed', () => {
  const fail = () => { throw new Error('native module trap'); };
  assert.equal(ac.suggest(SUGGEST, { wasmLoader: fail }).code, 'autoconfig_impl');
  assert.equal(capture(() => ac.estimateInputs(INPUTS, { wasmLoader: fail })).error.code, 'autoconfig_impl');
  assert.equal(capture(() => ac.estimateFootprint(FOOT, { wasmLoader: fail })).error.code, 'autoconfig_impl');
  assert.equal(capture(() => ac.estimateFootprintForAutotune(FOOT, { wasmLoader: fail })).error.code, 'autoconfig_impl');
});
test('autotune shares the Rust evaluator and never asks the strict port to serialize', () => {
  const operations = [], args = { ...FOOT, unused: 1n };
  const got = ac.estimateFootprintForAutotune(args, { wasmLoader: () => ({ llamacppAutoconfig(op, frame) {
    operations.push(op);
    return native.llamacppAutoconfig(op, frame);
  } }) });
  assert.deepEqual(got, oracle.estimateFootprintJs(args));
  assert.ok(operations.length > 0);
  assert.ok(operations.every(op => op === 11 || op === 12));
});
test('opaque continuations have bounded size independent of unused scalar input', () => {
  const frames = [], args = { ...FOOT, options: { 'cache-ram': -1 }, unused: 'x'.repeat(5 * 1024 * 1024) };
  const result = ac.estimateFootprint(args, { wasmLoader: () => ({ llamacppAutoconfig(op, frame) {
    if (op >= 11) {
      const text = JSON.stringify(frame); frames.push(text.length);
      assert.ok(text.length < 4096);
      assert.ok(!text.includes('xxxxx'));
    }
    return native.llamacppAutoconfig(op, frame);
  } }) });
  assert.equal(result.cacheRamUnbounded, true);
  assert.ok(frames.length > 0);
});
