'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./task-facts.cjs');
test('task facts oracle covers sandbox, pipeline, network and harness metadata', () => {
  const { cases } = JSON.parse(JSON.stringify(fixture()));
  assert.equal(cases.length, 16);
  for (const { input, expected } of cases) {
    assert.equal(expected.network, input.network === 'ready');
    assert.equal(expected.networkState, input.network);
    assert.equal(expected.promptPreparation.some(p => p.id === 'planner'), input.sandboxed && input.pipeline);
    assert.deepEqual(expected.approvals, {});
  }
  assert.deepEqual(cases.find(c => c.input.env.CODE_HARNESS_NAME === '__proto__').expected.harnesses[0].label, {});
  assert.equal(Object.hasOwn(cases.find(c => c.input.env.CODE_HARNESS_NAME === 'constructor').expected.harnesses[0], 'label'), false);
});
