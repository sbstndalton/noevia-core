'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

function everyScenario() {
  const path = require('node:path');
  const root = process.argv[1], phase = process.argv[2], kind = process.argv[3];
  const oracle = require(process.env.NOEVIA_FROZEN_CORE_ROOT
    ? path.join(process.env.NOEVIA_FROZEN_CORE_ROOT, 'server/llamacpp-autoconfig.cjs')
    : path.join(root, '../tests/reference/llamacpp-autoconfig-js.cjs'));
  const define = Object.defineProperty, apply = Reflect.apply;
  const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'every');
  const nativeEvery = descriptor.value, push = Array.prototype.push;
  const marker = new Error('callback primitive stop');
  let pattern, trace = [], api, calls = 0, saved, nested = false;
  const record = (...values) => apply(push, trace, [values]);
  const meta = () => ({
    blockCount: 3, headCount: 32, embeddingLength: 4096, headCountKv: 8,
    slidingWindow: 64, slidingWindowPattern: pattern,
  });
  const method = function every(callback) {
    if (this !== pattern) return apply(nativeEvery, this, arguments);
    record('every', ++calls, this.length);
    if (kind === 'mutation') {
      saved = callback;
      this[0] = false; this[1] = true; this.length = 2;
      define(Array.prototype, 'every', {
        configurable: true, writable: true,
        value(next) {
          record('replacement', this.length);
          record('retained callback', saved(this[1], 1, this));
          record('current callback', next(this[1], 1, this));
          return true;
        },
      });
      return false;
    }
    if (kind === 'callback-throw') {
      callback(this[0], { [Symbol.toPrimitive](hint) { record('index primitive', hint); throw marker; } }, this);
      record('after callback'); // Must remain unreachable.
      return true;
    }
    if (kind === 'reentrant' && !nested) {
      nested = true;
      const value = api.kvCacheBytes({ blockCount: 2, headCount: 4, embeddingLength: 16, headCountKv: 2 }, 7);
      record('nested', value);
    }
    return apply(nativeEvery, this, [
      function (value, index, array) {
        record('callback', value, index, array === pattern);
        return callback(value, index, array);
      },
    ]);
  };
  const install = () => {
    if (kind === 'wrong-brand') {
      define(Array.prototype, 'every', { configurable: true, writable: true, value: Uint8Array.prototype.every });
    } else if (kind === 'accessor') {
      define(Array.prototype, 'every', {
        configurable: true,
        get() { if (this === pattern) record('get every'); return method; },
      });
    } else {
      define(Array.prototype, 'every', { configurable: true, writable: true, value: method });
    }
  };
  let candidate, result;
  try {
    if (phase === 'before') install();
    candidate = require(path.join(root, 'llamacpp-autoconfig.cjs'));
    const run = implementation => {
      api = implementation; pattern = [true, false, true];
      trace = []; calls = 0; saved = undefined; nested = false;
      install();
      try {
        return { value: api.kvCacheBytes(meta(), 4096), trace };
      } catch (error) {
        return { error: { name: error.name, message: error.message, sameMarker: error === marker }, trace };
      }
    };
    result = { old: run(oracle), candidate: run(candidate) };
  } finally {
    define(Array.prototype, 'every', descriptor);
  }
  process.stdout.write(JSON.stringify(result));
}

for (const kind of ['wrong-brand', 'accessor', 'mutation', 'callback-throw', 'reentrant']) {
  test('every fidelity against the frozen oracle: ' + kind + ' before and after import', () => {
    for (const phase of ['before', 'after']) {
      const script = '(' + everyScenario.toString() + ')()';
      const result = JSON.parse(execFileSync(process.execPath, ['-e', script, __dirname, phase, kind], { encoding: 'utf8' }));
      assert.deepEqual(result.candidate, result.old, phase);
      if (kind === 'wrong-brand') assert.equal(result.old.error.name, 'TypeError');
      else assert.ok(result.old.trace.length > 0, phase + ': source operation must execute');
      if (kind === 'callback-throw') {
        assert.equal(result.old.error.sameMarker, true);
        assert.equal(result.old.trace.some(row => row[0] === 'after callback'), false);
      }
      if (kind === 'mutation') {
        assert.ok(result.old.trace.some(row => row[0] === 'retained callback' && row[1] === false));
        assert.ok(result.old.trace.some(row => row[0] === 'current callback' && row[1] === true));
      }
      if (kind === 'reentrant') assert.ok(result.old.trace.some(row => row[0] === 'nested'));
    }
  });
}
