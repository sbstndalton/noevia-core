'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { capture } = require('./task-acp.cjs');
test('synthetic ACP oracle preserves handshake, nested permission, updates and teardown', async () => {
  const result = await capture();
  assert.deepEqual(result.writes.map(row => row.method || row.noevia || 'reply'), ['start', 'initialize', 'session/new', 'session/prompt', 'reply']);
  assert.deepEqual(result.writes.at(-1), { jsonrpc: '2.0', id: 99, result: { outcome: { outcome: 'selected', optionId: 'allow' } } });
  assert.deepEqual(result.result, { stopReason: 'end_turn' });
  assert.deepEqual(result.updates, [{ sessionUpdate: 'agent_message_chunk' }]);
  assert.equal(result.stopped, true);
});
