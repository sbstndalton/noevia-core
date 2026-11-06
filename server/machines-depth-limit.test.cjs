'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const depthProbe = require('./machines-depth-limit.cjs');
test('floating CI checks stable HTTP coercion, not a V8 stack budget', () => {
  assert.equal(depthProbe.MEASURED_LINUX_X64, undefined);
  assert.equal(depthProbe.measure, undefined);
  for (const depth of [1, 16, 128]) {
    const result = depthProbe.runProbe('http', depth);
    assert.deepEqual([result.ok, result.status, result.writes], [true, 201, 1]);
  }
});
