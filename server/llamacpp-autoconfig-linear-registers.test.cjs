'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path');
const candidate = require('./llamacpp-autoconfig.cjs');
const oracle = require(process.env.NOEVIA_FROZEN_CORE_ROOT
  ? path.join(process.env.NOEVIA_FROZEN_CORE_ROOT, 'server/llamacpp-autoconfig.cjs')
  : '../tests/reference/llamacpp-autoconfig-js.cjs');

function callbackScenario(api, mode) {
  const trace = [], callbacks = [], sentinel = new Error('callback sentinel');
  const left = {}, right = {}, values = [left, right, left], seq = [left, right, left];
  let nested = false, throwOnce = mode === 'indexThrow', turn = 0;
  for (let index = 0; index < 3; index++) Object.defineProperty(seq, index, {
    configurable: true,
    get() {
      trace.push('get:' + index);
      if (index === 0 && throwOnce) { throwOnce = false; throw sentinel; }
      if (mode === 'getterReentrant' && index === 0 && !nested && callbacks.length) {
        nested = true;
        trace.push('nested:' + callbacks[callbacks.length - 1](right, 1));
        nested = false;
      }
      return values[index];
    },
  });
  Object.defineProperty(seq, 'every', { configurable: true, get() {
    trace.push('get:every');
    return function every(callback) {
      callbacks.push(callback); turn++;
      trace.push('call:every:' + turn + ':' + callback.length);
      let first = true;
      const index = { [Symbol.toPrimitive](hint) {
        trace.push('coerce:' + hint);
        if (mode === 'coercionThrow' && first) { first = false; throw sentinel; }
        if (mode === 'coercionReentrant' && !nested) {
          nested = true; trace.push('nested:' + callback(right, 1)); nested = false;
        }
        return 1;
      } };
      try { trace.push('answer:' + callback(left, index)); }
      catch (error) { trace.push('caught:' + (error === sentinel)); }
      trace.push('again:' + callback(left, 1));
      if (turn === 1) { values[0] = right; trace.push('mutate:0'); }
      return turn === 2;
    };
  } });
  const value = api.kvCacheBytes({
    blockCount: 3, headCount: 2, embeddingLength: 16, headCountKv: 1,
    slidingWindow: 4, slidingWindowPattern: seq,
  }, 16);
  const retained = callbacks.map(callback => callback(left, 1));
  return { value, trace, retained, fresh: callbacks[0] !== callbacks[1], lengths: callbacks.map(callback => callback.length) };
}
test('generated callbacks preserve live getters, coercions, retained per-iteration p and synchronous reentrancy', () => {
  for (const mode of ['coercionReentrant', 'getterReentrant', 'indexThrow', 'coercionThrow']) {
    const old = callbackScenario(oracle, mode), current = callbackScenario(candidate, mode);
    assert.deepEqual(current, old, mode);
    assert.ok(old.trace.includes('get:every'), mode);
    assert.ok(old.fresh, mode + ': new callback per period attempt');
    assert.equal(old.retained.length, 2, mode);
    assert.deepEqual(old.lengths, [2, 2], mode);
    if (mode.endsWith('Throw')) assert.ok(old.trace.includes('caught:true'), mode);
    else assert.ok(old.trace.some(entry => entry.startsWith('nested:')), mode);
  }
});

function comparatorScenario(api) {
  const trace = [], original = Array.prototype.sort;
  let nested = false;
  try {
    Array.prototype.sort = function sort(compare) {
      const a = { get 1() { trace.push('get:a'); return { [Symbol.toPrimitive](hint) { trace.push('coerce:a:' + hint); return 2; } }; } };
      const b = { get 1() {
        trace.push('get:b');
        if (!nested) { nested = true; trace.push('nested:' + compare([0, 2], [0, 3])); nested = false; }
        return { [Symbol.toPrimitive](hint) { trace.push('coerce:b:' + hint); return 3; } };
      } };
      trace.push('answer:' + compare(a, b));
      return Reflect.apply(original, this, [compare]);
    };
    const value = api.kvCacheBytes({ blockCount: 3, headCount: 2, embeddingLength: 16, headCountKv: [1, 2, 2] }, 16);
    return { value, trace };
  } finally { Array.prototype.sort = original; }
}
test('generic generated comparator evaluates both gets before numeric coercions and isolates nested activations', () => {
  const old = comparatorScenario(oracle);
  assert.deepEqual(comparatorScenario(candidate), old);
  assert.deepEqual(old.trace, ['get:b', 'nested:1', 'get:a', 'coerce:b:number', 'coerce:a:number', 'answer:1']);
});
