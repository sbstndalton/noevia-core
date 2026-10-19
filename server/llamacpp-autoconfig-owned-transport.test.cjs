'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const bridge = require('./dav-parse-wasm.cjs');

test('warmed actual v2 loader decodes complete positive-ref snapshots without private array hooks', () => {
  // Warm the exact configured module before installing hooks. This test requires
  // a v2 artifact; missing/old modules fail the marker check without a retry.
  const warm = bridge.llamacppAutoconfig(11, { function: 0, env: 1 });
  assert.equal(JSON.parse(warm.text).wire, 'state-v2');
  const define = Object.defineProperty, descriptor = Object.getOwnPropertyDescriptor;
  const old0 = descriptor(Array.prototype, '0'), old7 = descriptor(Array.prototype, '7');
  const oldMap = Array.prototype.map, oldSlice = Array.prototype.slice, oldIterator = Array.prototype[Symbol.iterator];
  const oldEvery = Array.prototype.every;
  let hits = 0, result;
  const unexpected = () => { hits++; throw new Error('owned private array hook'); };
  try {
    define(Array.prototype, '0', { configurable: true, set: unexpected });
    define(Array.prototype, '7', { configurable: true, set: unexpected });
    Array.prototype.map = unexpected;
    Array.prototype.slice = unexpected;
    Array.prototype.every = unexpected;
    Array.prototype[Symbol.iterator] = unexpected;
    result = bridge.llamacppAutoconfig(11, { function: 0, env: 1 });
  } finally {
    if (old0) define(Array.prototype, '0', old0); else delete Array.prototype[0];
    if (old7) define(Array.prototype, '7', old7); else delete Array.prototype[7];
    Array.prototype.map = oldMap;
    Array.prototype.slice = oldSlice;
    Array.prototype.every = oldEvery;
    Array.prototype[Symbol.iterator] = oldIterator;
  }
  assert.equal(hits, 0);
  const wire = JSON.parse(result.text);
  assert.equal(wire.wire, 'state-v2');
  assert.ok(wire.batch.some(operation => operation.ref < 0), 'actual module must emit signed references');
  const expanded = bridge.autoconfigReply(11, wire, 'state-v2');
  assert.deepEqual(result.reply, expanded, 'owned path must match the immutable exported decoder');
  const ref = n => assert.ok(Number.isSafeInteger(n) && n > 0, 'resolved positive ref: ' + n);
  const period = value => { if (value) ref(value.seq); };
  assert.ok(result.reply.batch.length > 1, 'multiple full operation snapshots exercised');
  for (const operation of result.reply.batch) {
    const state = operation.state;
    assert.deepEqual(Object.keys(state), ['pc', 'env', 'stack', 'catches', 'mode', 'target', 'period', 'sum']);
    ref(state.env);
    for (const value of state.stack) ref(value);
    for (const entry of state.catches) ref(entry[2]);
    period(state.period);
    if (state.sum) {
      period(state.sum.cache);
      for (const value of state.sum.raw) ref(value);
    }
    for (const value of operation.args) ref(value);
    if (operation.ref !== 0) ref(operation.ref);
  }
  for (let index = 1; index < result.reply.batch.length; index++) {
    assert.notEqual(result.reply.batch[index - 1].state, result.reply.batch[index].state);
    assert.notEqual(result.reply.batch[index - 1].state.stack, result.reply.batch[index].state.stack);
    assert.notEqual(result.reply.batch[index - 1].state.catches, result.reply.batch[index].state.catches);
  }
});
