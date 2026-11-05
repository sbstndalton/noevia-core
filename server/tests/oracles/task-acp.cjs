'use strict';
// Node 22 oracle for the existing sandbox's wire contract. No process or network is started.
const { EventEmitter } = require('node:events');
const { connectAcp } = require('../../code-acp.cjs');
async function capture() {
  const writes = [], updates = [];
  const socket = new EventEmitter();
  socket.setEncoding = () => {};
  let promptId;
  const reply = (id, result) => queueMicrotask(() => socket.emit('data', JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'));
  socket.write = (line) => {
    const message = JSON.parse(line); writes.push(message);
    if (message.method === 'initialize') reply(message.id, { protocolVersion: 1, agentInfo: { name: 'synthetic-agent', version: '1' } });
    if (message.method === 'session/new') reply(message.id, { sessionId: 'session' });
    if (message.method === 'session/prompt') {
      promptId = message.id;
      queueMicrotask(() => {
        socket.emit('data', JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk' } } }) + '\n');
        socket.emit('data', JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'session/request_permission', params: {} }) + '\n');
      });
    }
    if (message.id === 99 && message.result) reply(promptId, { stopReason: 'end_turn' });
    return true;
  };
  let stopped = false;
  socket.destroy = () => { stopped = true; };
  const agent = await connectAcp({ endpoint: 'synthetic:1', cwd: '/synthetic/tree', home: '/synthetic/home',
    env: { PATH: '/synthetic/bin', LANG: 'C' }, connectFn: () => socket,
    handlers: { requestPermission: async () => ({ outcome: 'selected', optionId: 'allow' }),
      readTextFile: async () => ({ content: 'synthetic' }), writeTextFile: async () => null,
      sessionUpdate: update => updates.push(update) } });
  const result = await agent.prompt('change this');
  return { writes, updates, result, agent: agent.agent, stopped };
}
if (require.main === module) capture().then(value => process.stdout.write(JSON.stringify(value, null, 2) + '\n')).catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
module.exports = { capture };
