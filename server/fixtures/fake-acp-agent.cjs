'use strict';
// A scripted ACP agent for `code-acp.test.cjs`: it speaks the protocol over stdio and does
// whatever SCRIPT says, so the client can be tested without installing a real harness.
// SCRIPT is a JSON array of steps: {update}, {permission}, {read}, {write}, {fail}, {hang}.
let buffer = '';
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const script = JSON.parse(process.env.SCRIPT || '[]');
let nextId = 1;
const waiting = new Map();
const ask = (method, params) => new Promise((resolve) => { const id = nextId++; waiting.set(id, resolve); send({ jsonrpc: '2.0', id, method, params }); });

process.stdin.setEncoding('utf8');
process.stdin.on('data', async (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1);
    if (!line) continue;
    const m = JSON.parse(line);
    if (m.id !== undefined && m.method === undefined) { waiting.get(m.id)?.(m); waiting.delete(m.id); continue; }
    if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    else if (m.method === 'session/new') send({ jsonrpc: '2.0', id: m.id, result: { sessionId: 'session-1', _meta: { sawPermission: m.params?._meta?.noevia?.permission ?? null } } });
    else if (m.method === 'session/prompt') {
      const seen = [];
      for (const step of script) {
        if (step.update) send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-1', update: step.update } });
        if (step.permission) seen.push(await ask('session/request_permission', step.permission));
        if (step.read) seen.push(await ask('fs/read_text_file', step.read));
        if (step.write) seen.push(await ask('fs/write_text_file', step.write));
        if (step.unknown) seen.push(await ask('something/unsupported', {}));
        if (step.env) send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-1', update: { sessionUpdate: 'agent_message_chunk', env: process.env[step.env] ?? null } } });
        if (step.fail) return send({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: step.fail } });
        if (step.hang) return; // never answers: the client must be able to stop us
      }
      send({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn', seen } });
    } else if (m.method === 'session/cancel') { if (process.env.IGNORE_CANCEL) return; process.exit(0); }
    else if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no' } });
  }
});
