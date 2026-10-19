'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const current = require('./dav-parse-wasm.cjs');

// The expected trace is the public strict reply validator at core c699e23.
// A local qualification can additionally execute that exact frozen bridge.
const frozen = process.env.NOEVIA_FROZEN_STRICT_BRIDGE
  ? require(process.env.NOEVIA_FROZEN_STRICT_BRIDGE) : null;

test('strict reply validation reads the dynamic Array.isArray callee before its argument', () => {
  const own = Object.getOwnPropertyDescriptor;
  const define = Object.defineProperty;
  const apply = Reflect.apply;
  const push = Array.prototype.push;
  const descriptor = own(Array, 'isArray');
  const isArray = Array.isArray;
  const observe = bridge => {
    const trace = [];
    const record = value => apply(push, trace, [value]);
    const reply = {};
    define(reply, 'batch', {
      enumerable: true,
      get() { record('batch-getter'); return []; },
    });
    let result;
    try {
      define(Array, 'isArray', {
        configurable: true,
        get() { record('Array.isArray-getter'); return isArray; },
      });
      result = bridge.autoconfigReply(1, reply);
    } finally {
      define(Array, 'isArray', descriptor);
    }
    assert.equal(result, reply);
    return trace;
  };
  const expected = [
    'Array.isArray-getter', 'Array.isArray-getter',
    'batch-getter', 'batch-getter', 'Array.isArray-getter',
  ];
  if (frozen) assert.deepEqual(observe(frozen), expected);
  assert.deepEqual(observe(current), expected);
});
