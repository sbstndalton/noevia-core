'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const host = require('./llamacpp-autoconfig-host.cjs');
const port = require('./dav-parse-wasm.cjs');
const publicApi = require('./llamacpp-autoconfig.cjs');
const oracle = require(process.env.NOEVIA_FROZEN_CORE_ROOT
  ? path.join(process.env.NOEVIA_FROZEN_CORE_ROOT, 'server/llamacpp-autoconfig.cjs')
  : '../tests/reference/llamacpp-autoconfig-js.cjs');
const nativeEvery = Array.prototype.every;
const nativeIsArray = Array.isArray;
const define = Object.defineProperty;
const bits = value => { const buffer = Buffer.alloc(8); buffer.writeDoubleBE(value); return buffer.toString('hex'); };

function sample(kind, context = 4096) {
  const trace = [], marker = new Error('prefix getter stop');
  let pattern = [true, false, true], restore = () => {};
  const log = (...values) => trace.push(values);
  const every = function (callback) {
    log('every', this.length);
    return Reflect.apply(nativeEvery, this, [function (value, index, array) {
      log('callback', value, index);
      return callback(value, index, array);
    }]);
  };
  define(pattern, 'every', { configurable: true, value: every });
  if (['mutation', 'accessor', 'accessor-throw', 'hole', 'inherited', 'zero', 'beyond-length'].includes(kind)) {
    let calls = 0;
    define(pattern, 'every', { configurable: true, value(callback) {
      log('every', ++calls, this.length);
      log('callback', callback(this[0], 0, this));
      if (kind === 'mutation') { this[0] = false; this[1] = true; this[2] = false; }
      if (kind === 'accessor' || kind === 'accessor-throw') {
        define(this, '0', { configurable: true, get() {
          log('index getter');
          if (kind === 'accessor-throw') throw marker;
          return false;
        } });
      }
      if (kind === 'hole') delete this[0];
      if (kind === 'inherited') {
        delete this[0];
        const prototype = Object.create(Array.prototype);
        define(prototype, '0', { configurable: true, get() { log('inherited getter'); return false; } });
        Object.setPrototypeOf(this, prototype);
      }
      if (kind === 'zero') { this.length = 0; return false; }
      if (kind === 'beyond-length') {
        if (calls === 1) return false;
        this.length = 1;
      }
      return true;
    } });
  }
  if (kind === 'proxy') {
    pattern = new Proxy(pattern, {
      get(target, key, receiver) { log('proxy get', String(key)); return Reflect.get(target, key, receiver); },
      getOwnPropertyDescriptor(target, key) { log('proxy descriptor', String(key)); return Reflect.getOwnPropertyDescriptor(target, key); },
    });
  }
  if (kind === 'non-array') {
    pattern = { 0: true, 1: false, 2: true, length: 3, every };
    const descriptor = Object.getOwnPropertyDescriptor(Array, 'isArray');
    define(Array, 'isArray', { configurable: true, writable: true, value(value) {
      if (value === pattern) { log('accept non-array'); return true; }
      return nativeIsArray(value);
    } });
    restore = () => define(Array, 'isArray', descriptor);
  }
  const meta = { blockCount: 3, headCount: 32, embeddingLength: 4096, headCountKv: 8, slidingWindow: 64, slidingWindowPattern: pattern };
  if (kind === 'head-sequence') meta.headCountKv = [8, 8, 8];
  if (kind === 'nonnumeric') {
    meta.headCount = { valueOf() { log('head coercion'); return 32; } };
    meta.headCountKv = null;
  }
  if (kind === 'finite-bits') meta.sharedKvLayers = 0.1;
  if (kind === 'zero-bits' || kind === 'infinite-bits') meta.sharedKvLayers = 3;
  return { meta, context, trace, marker, restore };
}

function observe(kind, context, candidate) {
  const fixture = sample(kind, context);
  const stats = { requests: [], facts: [], chunks: 0 };
  let result;
  try {
    let value;
    if (candidate) {
      const outcome = host.invokeOutcome('kvCacheBytes', [fixture.meta, fixture.context], () => ({
        llamacppAutoconfig(op, args) {
          if (op === 12 && args.state.mode === 6) stats.facts.push(args.frame.facts.safe);
          const response = port.llamacppAutoconfig(op, args);
          for (const operation of response.reply.batch || []) {
            const request = response.reply.wire === 'state-v2d' ? operation[1] : operation.request;
            if (request.op === 'ownBooleanPrefixFacts') stats.requests.push(request.data.count);
            if (request.op === 'booleanChunk') stats.chunks++;
          }
          return response;
        },
      }));
      if (outcome.fault) throw outcome.fault;
      value = outcome.value;
    } else value = oracle.kvCacheBytes(fixture.meta, fixture.context);
    result = { kind: 'return', bits: bits(value) };
  } catch (error) {
    result = { kind: 'throw', name: error.name, message: error.message, sameMarker: error === fixture.marker };
  } finally { fixture.restore(); }
  return { result, trace: fixture.trace, stats };
}

function compare(kind, context) {
  const expected = observe(kind, context, false), actual = observe(kind, context, true);
  assert.deepEqual({ result: actual.result, trace: actual.trace }, { result: expected.result, trace: expected.trace }, kind);
  return actual;
}

test('fresh own-boolean prefix facts run after every mutations and support a zero prefix', () => {
  for (const kind of ['normal', 'mutation', 'zero', 'non-array']) {
    const result = compare(kind, 4096);
    assert.ok(result.stats.requests.length > 0, kind + ': new Rust-selected request must execute');
    assert.ok(result.stats.facts.includes(true), kind + ': descriptor proof must enable existing arithmetic');
    if (kind === 'zero') { assert.deepEqual(result.stats.requests, [0]); assert.equal(result.stats.chunks, 0); }
    else assert.ok(result.stats.chunks > 0);
  }
});

test('accessors, holes, inherited values, Proxies and prefixes past length retain original reads', () => {
  for (const kind of ['accessor', 'accessor-throw', 'hole', 'inherited', 'proxy', 'beyond-length']) {
    const result = compare(kind, 4096);
    assert.ok(result.stats.requests.length > 0, kind);
    assert.ok(result.stats.facts.includes(false), kind);
    assert.equal(result.stats.chunks, 0, kind);
    if (kind === 'proxy') assert.equal(result.trace.some(row => row[0] === 'proxy descriptor'), false);
    if (kind === 'accessor-throw') assert.equal(result.result.sameMarker, true);
  }
});

test('existing scalar-head and primitive-number gates preserve original fallback coercions', () => {
  for (const kind of ['head-sequence', 'nonnumeric']) {
    const result = compare(kind, 4096);
    assert.equal(result.stats.requests.length, 0, kind + ': existing gate must decline before prefix proof');
  }
});

test('existing Sum arithmetic and public wrapper preserve frozen numeric output bits', () => {
  for (const [kind, context] of [['finite-bits', 65536.25], ['zero-bits', 4096], ['infinite-bits', Infinity], ['normal', -0], ['normal', NaN]]) {
    const result = compare(kind, context);
    if (context > 0) assert.ok(result.stats.facts.includes(true), kind);
  }
  const fixture = sample('normal', 4096);
  try {
    assert.equal(bits(publicApi.kvCacheBytes(fixture.meta, fixture.context)), bits(oracle.kvCacheBytes(fixture.meta, fixture.context)));
  } finally { fixture.restore(); }
});


test('malformed own-prefix metadata remains an infrastructure fault', () => {
  for (const data of [null, {}, { count: '3' }, { count: -1 }, { count: NaN }, { count: Infinity }]) {
    const fixture = sample('normal', 4096);
    let injected = false;
    const outcome = host.invokeOutcome('kvCacheBytes', [fixture.meta, fixture.context], () => ({
      llamacppAutoconfig(op, args) {
        const response = port.llamacppAutoconfig(op, args);
        for (const operation of response.reply.batch || []) {
          const request = response.reply.wire === 'state-v2d' ? operation[1] : operation.request;
          if (request.op === 'ownBooleanPrefixFacts') {
            request.data = data;
            injected = true;
          }
        }
        return response;
      },
    }));
    assert.equal(injected, true);
    assert.ok(outcome.fault, 'invalid metadata must not enter business error handling');
    assert.equal(outcome.fault.name, 'AutoconfigProtocolError');
    assert.equal(Object.hasOwn(outcome, 'value'), false);
  }
});
