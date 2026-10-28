#!/usr/local/bin/node
'use strict';
// Fixed synthetic RPC backend for the real packaged pi ACP bridge; no model calls.
const fs = require('node:fs'), assert = require('node:assert/strict');
assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 1000);
assert.equal(process.env.SANDBOX_BRIDGE_IMPL, undefined, 'the real CLI strips its bridge flag before spawning pi');
const { mode } = JSON.parse(fs.readFileSync('case.json', 'utf8'));
let buffer = '', requested = false, decisions = 0, confirmed = null;
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
if (mode === 'pi-stubborn-cancel') process.on('SIGTERM', () => {});
function finish(value) {
  fs.writeFileSync('pi-decision.json', JSON.stringify(value));
  send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: JSON.stringify(value) } });
  send({ type: 'agent_settled' });
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk; assert.ok(buffer.length < 1024 * 1024);
  let i;
  while ((i = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.type === 'prompt') {
      setInterval(() => {}, 1000); // A real RPC engine need not exit merely because its stdin ends.
      send({ type: 'response', id: m.id, success: true });
      send({ type: 'extension_ui_request', id: 'owned-confirm', method: 'confirm', message: JSON.stringify({ noevia: 'tool_call', toolCallId: 'owned-call', toolName: 'bash', input: { command: 'synthetic-only' } }) });
      requested = true;
    } else if (m.type === 'extension_ui_response' && m.id === 'owned-confirm') {
      assert.equal(requested, true);
      decisions++; confirmed = m.confirmed;
      assert.equal(decisions, 1, 'a late answer cannot produce another response to the expired request');
      if (mode === 'pi-allow') { assert.equal(m.confirmed, true); finish({ confirmed: true }); }
      else if (mode === 'pi-timeout-late') {
        assert.equal(m.confirmed, false);
        send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'TIMEOUT_REFUSED' } });
      }
      else if (mode === 'pi-deny') {
        assert.equal(m.confirmed, false);
        send({ type: 'extension_ui_request', id: 'owned-reason', method: 'input', placeholder: JSON.stringify({ noevia: 'refusal_reason', toolCallId: 'owned-call', toolName: 'bash' }) });
      } else { assert.equal(m.confirmed, false); fs.writeFileSync('pi-refused.json', 'true'); }
    } else if (m.type === 'extension_ui_response' && m.id === 'owned-reason') {
      assert.equal(m.value, 'owned synthetic refusal');
      fs.writeFileSync('reason.json', JSON.stringify({ reason: m.value }));
      send({ type: 'extension_ui_request', id: 'owned-again', method: 'input', placeholder: JSON.stringify({ noevia: 'refusal_reason', toolCallId: 'owned-call', toolName: 'bash' }) });
    } else if (m.type === 'extension_ui_response' && m.id === 'owned-again') {
      assert.equal(m.cancelled, true); finish({ confirmed: false, reason: 'owned synthetic refusal', readOnce: true });
    } else if (m.type === 'abort') {
      fs.writeFileSync('pi-aborted.json', JSON.stringify({ requested, aborted: true }));
      if (mode === 'pi-timeout-late') {
        assert.equal(decisions, 1); assert.equal(confirmed, false);
        send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'LATE_REPLY_IGNORED' } });
      }
      send({ type: 'agent_settled' });
    }
  }
});
