'use strict';
// A stand-in for `pi --mode rpc` (pi-mono docs/rpc.md shapes): on a prompt it announces a bash
// tool, asks noevia's gate through an extension confirm, runs it only if confirmed, then ends.
// FAKE_PI_LOG records what it did so the test can prove a declined command never ran.
const fs = require('node:fs');
const out = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const log = (line) => { if (process.env.FAKE_PI_LOG) fs.appendFileSync(process.env.FAKE_PI_LOG, line + '\n'); };
let buffer = '', confirmId = null, prompt = null;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\n')) !== -1) {
    const msg = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1);
    if (msg.type === 'prompt') {
      prompt = msg.message;
      out({ id: msg.id, type: 'response', command: 'prompt', success: true });
      out({ type: 'agent_start' });
      out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Cleaning up. ' } });
      const input = { command: process.env.FAKE_PI_COMMAND || 'rm -rf build' };
      out({ type: 'tool_execution_start', toolCallId: 'call_1', toolName: 'bash', args: input });
      confirmId = 'ui-1';
      out({ type: 'extension_ui_request', id: confirmId, method: 'confirm', title: 'Allow bash?',
        message: JSON.stringify({ noevia: 'tool_call', toolCallId: 'call_1', toolName: 'bash', input }) });
    } else if (msg.type === 'extension_ui_response' && msg.id === confirmId) {
      log(msg.confirmed === true ? 'ran' : 'blocked');
      out({ type: 'tool_execution_end', toolCallId: 'call_1', isError: msg.confirmed !== true });
      out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: msg.confirmed ? 'Done.' : 'Skipped.' } });
      out({ type: 'agent_end' });
    } else if (msg.type === 'abort') { log('aborted'); out({ type: 'agent_end' }); }
  }
});
