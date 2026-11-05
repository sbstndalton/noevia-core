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

test('pending approvals do not block other ACP requests or updates', async () => {
  const { EventEmitter } = require('node:events');
  const { connectAcp } = require('../../code-acp.cjs');
  const socket = new EventEmitter();socket.setEncoding = () => {};
  let ready, promptId;
  const observed = new Promise(resolve => { ready = resolve; });
  const pending = [], writes = [];
  let updates = 0, stopped = false;
  const reply = (id, result) => queueMicrotask(() => socket.emit('data', JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'));
  socket.write = line => {
    const message = JSON.parse(line);writes.push(message);
    if (message.method === 'initialize') reply(message.id, { protocolVersion: 1 });
    if (message.method === 'session/new') reply(message.id, { sessionId: 'session' });
    if (message.method === 'session/prompt') {
      promptId = message.id;
      queueMicrotask(() => {
        for (const row of [
          { jsonrpc: '2.0', id: 11, method: 'session/request_permission', params: {} },
          { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'usage_update' } } },
          { jsonrpc: '2.0', id: 12, method: 'session/request_permission', params: {} },
        ]) socket.emit('data', JSON.stringify(row) + '\n');
      });
    }
    if (writes.filter(row => row.id === 11 || row.id === 12).length === 2) reply(promptId, { stopReason: 'end_turn' });
    return true;
  };
  socket.destroy = () => { stopped = true; };
  const agent = await connectAcp({ endpoint: 'synthetic:1', cwd: '/synthetic/tree', env: { PATH: '/synthetic/bin' }, connectFn: () => socket,
    handlers: { requestPermission: () => new Promise(resolve => { pending.push(resolve);if (pending.length === 2) ready(); }),
      readTextFile: async () => ({ content: '' }), writeTextFile: async () => null, sessionUpdate: () => { updates++; } } });
  const running = agent.prompt('synthetic');
  let timer;
  try { await Promise.race([observed, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Second callback did not execute')), 2000); })]); }
  finally { clearTimeout(timer); }
  const concurrent = { active: pending.length, updates };
  assert.deepEqual(concurrent, { active: 2, updates: 1 });
  for (const resolve of pending) resolve({ outcome: 'selected', optionId: 'allow' });
  assert.equal((await running).stopReason, 'end_turn');assert.equal(stopped, true);
  if (process.env.TASK_ACP_EVIDENCE) require('node:fs').writeFileSync(require('node:path').join(process.env.TASK_ACP_EVIDENCE, 'task-acp-concurrent-node.json'), JSON.stringify(concurrent, null, 2) + '\n');
});
