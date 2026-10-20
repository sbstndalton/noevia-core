'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const bridge = require('./dav-parse-wasm.cjs');

const state = () => [12, 7, [8, 9], [[13, 1, 7]], 2, 14, null, null];
const operation = fields => ({ state: fields, request: { op: 'get', data: null }, args: [8, 9], ref: 8000000000000001 });
const reply = fields => ({ wire: 'state-v1', batch: [operation(fields)] });
const reject = value => assert.throws(() => bridge.autoconfigReply(12, value, true),
  error => error instanceof bridge.DavParseError && error.reason === 'reply');

test('state-v1 reconstructs each complete operation state in the original key order', () => {
  const a = state(), b = state();
  b[0] = 15; b[2] = [9];
  const result = bridge.autoconfigReply(12, { wire: 'state-v1', batch: [operation(a), operation(b)] }, true);
  assert.deepEqual(result.batch[0].state, { pc: 12, env: 7, stack: [8, 9], catches: [[13, 1, 7]], mode: 2, target: 14, period: null, sum: null });
  assert.deepEqual(Object.keys(result.batch[0].state), ['pc', 'env', 'stack', 'catches', 'mode', 'target', 'period', 'sum']);
  assert.equal(result.batch[1].state.pc, 15);
  assert.deepEqual(result.batch[1].state.stack, [9]);
  assert.notEqual(result.batch[0].state, result.batch[1].state);
  assert.deepEqual(bridge.autoconfigReply(11, { wire: 'state-v1', done: 5 }, true), { done: 5 });
  assert.deepEqual(bridge.autoconfigReply(12, { wire: 'state-v1', throw: 6 }, true), { throw: 6 });
});

test('state-v1 rejects legacy/missing/wrong markers and malformed tuples without retry', () => {
  const legacy = { batch: [operation({ pc: 12, env: 7, stack: [8, 9], catches: [[13, 1, 7]], mode: 2, target: 14, period: null, sum: null })] };
  reject(legacy);
  reject({ ...legacy, wire: 'state-v0' });
  reject({ ...legacy, wire: 'state-v1' });
  reject({ wire: 'state-v1', done: 0 });
  reject({ wire: 'state-v1', throw: -1 });
  reject({ wire: 'state-v1', batch: [] });
  reject(reply(state().slice(0, 7)));
  reject(reply([...state(), null]));
  for (const [index, value] of [[0, -1], [1, 0], [2, [0]], [3, [[13, 1]]], [4, 8], [5, 0.5], [6, []], [7, false]]) {
    const fields = state(); fields[index] = value; reject(reply(fields));
  }
});

test('state-v1 expansion uses no inherited numeric setter or collection callback', () => {
  const fields = state(), packet = reply(fields);
  const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, '0');
  const define = Object.defineProperty;
  let hits = 0, result;
  try {
    define(Array.prototype, '0', { configurable: true, set() { hits++; } });
    result = bridge.autoconfigReply(12, packet, true);
  } finally {
    if (descriptor) define(Array.prototype, '0', descriptor);
    else delete Array.prototype[0];
  }
  assert.equal(hits, 0);
  assert.equal(result.batch[0].state.pc, 12);
});

test('untagged object validators and strict reply objects retain their public behavior', () => {
  const plain = { batch: [operation({ pc: 12, env: 7, stack: [8, 9], catches: [[13, 1, 7]], mode: 2, target: 14, period: null, sum: null })] };
  assert.equal(bridge.autoconfigReply(12, plain), plain);
  const strict = { rows: [] };
  assert.equal(bridge.autoconfigReply(1, strict), strict);
});
