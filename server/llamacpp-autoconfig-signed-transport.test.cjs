'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const bridge = require('./dav-parse-wasm.cjs');
const BASE = 8000000000000000, MAX = 9007199254740991;
const period = seq => ({ seq, returnPc: 1, len: 4096, p: 1, i: 0, need: 0, chunks: [{ base: 0, hex: '0f' }] });
const fields = () => [12, -1, [-2, BASE, BASE + 33, MAX], [[13, 1, -3]], 2, 14, period(-4), {
  cache: period(-5), raw: [-6, -7, -8, -9, -10, -11, -12, -13],
  numbers: ['8000000000000000', '7ff8000000000001', '7ff0000000000000', 'fff0000000000000', '0000000000000001', 'bff0000000000000'],
  total: '8000000000000000',
}];
const operation = state => ({ state, request: { op: 'literal', data: { value: -1, ref: -32, env: BASE + 1, counter: -0 } }, args: [-14, -32, MAX], ref: -15 });
const packet = state => ({ wire: 'state-v2', batch: [operation(state)] });
const decode = value => bridge.autoconfigReply(12, value, 'state-v2');
const reject = value => assert.throws(() => decode(value),
  error => error instanceof bridge.DavParseError && error.reason === 'reply');

test('state-v2 decodes all32 aliases and boundaries only in explicit reference slots', () => {
  const state = fields();
  state[2] = Array.from({ length: 32 }, (_, i) => -i - 1);
  state[5] = BASE + 1; // A numeric counter that resembles a reference stays unchanged.
  const input = packet(state), before = structuredClone(input);
  const result = decode(input), out = result.batch[0], expanded = out.state;
  assert.deepEqual(input, before);
  assert.deepEqual(expanded.stack, Array.from({ length: 32 }, (_, i) => BASE + i + 1));
  assert.equal(expanded.env, BASE + 1);
  assert.deepEqual(expanded.catches, [[13, 1, BASE + 3]]);
  assert.equal(expanded.period.seq, BASE + 4);
  assert.equal(expanded.sum.cache.seq, BASE + 5);
  assert.deepEqual(expanded.sum.raw, Array.from({ length: 8 }, (_, i) => BASE + i + 6));
  assert.deepEqual(expanded.sum.numbers, input.batch[0].state[7].numbers);
  assert.equal(expanded.sum.total, '8000000000000000');
  assert.equal(expanded.target, BASE + 1);
  assert.deepEqual(out.args, [BASE + 14, BASE + 32, MAX]);
  assert.equal(out.ref, BASE + 15);
  assert.equal(out.request, input.batch[0].request);
  assert.equal(out.request.data, input.batch[0].request.data);
  assert.ok(Object.is(out.request.data.counter, -0));
  assert.deepEqual(Object.keys(expanded), ['pc', 'env', 'stack', 'catches', 'mode', 'target', 'period', 'sum']);
  for (const value of [1, BASE, BASE + 33, MAX]) {
    assert.deepEqual(decode({ wire: 'state-v2', done: value }), { done: value });
  }
  for (let n = 1; n <= 32; n++) {
    assert.deepEqual(decode({ wire: 'state-v2', done: -n }), { done: BASE + n });
    assert.deepEqual(decode({ wire: 'state-v2', throw: -n }), { throw: BASE + n });
  }
});

test('state-v2 copies complete nested snapshots without mutating frozen input', () => {
  const freeze = value => {
    if (value && typeof value === 'object') {
      for (const key of Object.keys(value)) freeze(value[key]);
      Object.freeze(value);
    }
    return value;
  };
  const input = packet(fields()), before = structuredClone(input);
  input.batch.push(operation(fields()));
  before.batch.push(structuredClone(input.batch[1]));
  const result = decode(freeze(input));
  assert.deepEqual(input, before);
  assert.notEqual(result.batch, input.batch);
  assert.notEqual(result.batch[0].state, input.batch[0].state);
  assert.notEqual(result.batch[0].state.period, input.batch[0].state[6]);
  assert.notEqual(result.batch[0].state.sum, input.batch[0].state[7]);
  assert.notEqual(result.batch[0].state.sum.numbers, input.batch[0].state[7].numbers);
  assert.notEqual(result.batch[0].state.stack, result.batch[1].state.stack);
});

test('state-v2 rejects invalid aliases, negativezero, counters and markers without retry', () => {
  for (const value of [0, -0, -33, -1.5, NaN, Infinity, MAX + 1, '-1']) {
    reject({ wire: 'state-v2', done: value });
    reject({ wire: 'state-v2', throw: value });
    for (const change of [
      f => { f[1] = value; }, f => { f[2][0] = value; }, f => { f[3][0][2] = value; },
      f => { f[6].seq = value; }, f => { f[7].cache.seq = value; }, f => { f[7].raw[0] = value; },
    ]) { const f = fields(); change(f); reject(packet(f)); }
  }
  for (const value of [-1, -0, 0.5, Infinity, MAX + 1]) {
    for (const change of [
      f => { f[0] = value; }, f => { f[3][0][0] = value; }, f => { f[3][0][1] = value; },
      f => { f[4] = value; }, f => { f[5] = value; }, f => { f[6].len = value; },
      f => { f[7].cache.need = value; }, f => { f[6].chunks[0].base = value; },
    ]) { const f = fields(); change(f); reject(packet(f)); }
  }
  for (const value of [-0, -33, 0.5]) {
    const a = packet(fields()); a.batch[0].ref = value; reject(a);
    const b = packet(fields()); b.batch[0].args[0] = value; reject(b);
  }
  const zeroResult = packet(fields()); zeroResult.batch[0].ref = 0;
  assert.equal(decode(zeroResult).batch[0].ref, 0);
  reject({ done: 1 });
  reject({ wire: 'state-v1', done: 1 });
  reject({ wire: 'state-v3', done: 1 });
  reject({ wire: 'state-v2', batch: [] });
  const object = packet(fields()); object.batch[0].state = { pc: 1 }; reject(object);
  const short = fields(); short.pop(); reject(packet(short));
  const long = fields(); long.push(null); reject(packet(long));
  const overflowing = fields(); overflowing[2] = Array(257).fill(1); reject(packet(overflowing));
});

test('state-v2 private copies do not invoke numeric setters or mutable array methods', () => {
  const input = packet(fields()), define = Object.defineProperty;
  const old0 = Object.getOwnPropertyDescriptor(Array.prototype, '0');
  const old7 = Object.getOwnPropertyDescriptor(Array.prototype, '7');
  const oldMap = Array.prototype.map, oldSlice = Array.prototype.slice, oldIterator = Array.prototype[Symbol.iterator];
  let hits = 0, result;
  const unexpected = () => { hits++; throw new Error('private array hook'); };
  try {
    define(Array.prototype, '0', { configurable: true, set: unexpected });
    define(Array.prototype, '7', { configurable: true, set: unexpected });
    Array.prototype.map = unexpected;
    Array.prototype.slice = unexpected;
    Array.prototype[Symbol.iterator] = unexpected;
    result = decode(input);
  } finally {
    if (old0) define(Array.prototype, '0', old0); else delete Array.prototype[0];
    if (old7) define(Array.prototype, '7', old7); else delete Array.prototype[7];
    Array.prototype.map = oldMap; Array.prototype.slice = oldSlice; Array.prototype[Symbol.iterator] = oldIterator;
  }
  assert.equal(hits, 0);
  assert.equal(result.batch[0].state.sum.raw[7], BASE + 13);
});

test('legacy helper selectors retain v1 and object semantics while v2 fails closed on old output', () => {
  const objectState = { pc: 1, env: 1, stack: [], catches: [], mode: 0, target: 0, period: null, sum: null };
  const plain = { batch: [{ state: objectState, request: { op: 'get', data: -1 }, args: [1], ref: 0 }] };
  assert.equal(bridge.autoconfigReply(12, plain, false), plain);
  const v1 = { wire: 'state-v1', batch: [{ state: [1, 1, [], [], 0, 0, null, null], request: { op: 'get', data: -1 }, args: [1], ref: BASE + 1 }] };
  assert.equal(bridge.autoconfigReply(12, v1, true).batch[0].ref, BASE + 1);
  reject(plain);
  reject({ wire: 'state-v1', done: 1 });
  const strict = { literal: -1 };
  assert.equal(bridge.autoconfigReply(1, strict, 'state-v2'), strict);
});
