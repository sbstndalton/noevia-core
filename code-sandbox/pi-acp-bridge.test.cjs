'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createBridge, lines } = require('./pi-acp-bridge.cjs');

/** A fake `pi --mode rpc` child: readable/writable stdio, and a pid we can assert kill() calls against. */
function fakePi({ pid = 4242 } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = { writable: true, writes: [], write(s) { this.writes.push(s); } };
  child.killCalls = [];
  child.kill = (sig) => { child.killCalls.push(sig); };
  return child;
}

function harness({ spawnFn, env = { HOME: '/task/home' }, askTimeoutMs, onLog } = {}) {
  const toBridge = new PassThrough();
  const fromBridge = new PassThrough();
  const out = [];
  fromBridge.on('error', () => { /* write-after-end once the bridge closes the session; expected */ });
  fromBridge.on('data', (chunk) => {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (line.trim()) out.push(JSON.parse(line));
    }
  });
  const bridge = createBridge({ input: toBridge, output: fromBridge, spawnFn, env, askTimeoutMs, onLog });
  const send = (msg) => toBridge.write(JSON.stringify(msg) + '\n');
  return { bridge, send, out, toBridge, fromBridge };
}

async function flush() { await new Promise((r) => setImmediate(r)); }

test('lines() reports an overflow instead of silently dropping the buffer', () => {
  const seen = [];
  let overflowSize = null;
  const feed = lines((m) => seen.push(m), (size) => { overflowSize = size; }, 16);
  feed('{"a":1}\n'); // fits, parses fine
  assert.deepEqual(seen, [{ a: 1 }]);
  feed('x'.repeat(20)); // no newline yet, exceeds the 16-byte limit
  assert.equal(overflowSize, 20);
  // Buffer was cleared: a well-formed line arriving right after parses normally, proving the
  // caller (not `lines` itself) is what decides what "overflow" means for the session.
  feed('{"b":2}\n');
  assert.deepEqual(seen, [{ a: 1 }, { b: 2 }]);
});

test('an oversized line from pi fails the session with a JSON-RPC error instead of hanging a turn', async () => {
  const logs = [];
  const child = fakePi();
  const { bridge, send, out } = harness({ spawnFn: () => child, askTimeoutMs: 50, onLog: (m) => logs.push(m) });
  send({ id: 1, method: 'initialize', params: {} });
  send({ id: 2, method: 'session/new', params: { cwd: '/task' } });
  await flush();
  send({ id: 3, method: 'session/prompt', params: { sessionId: 'pi-1', prompt: [{ type: 'text', text: 'hi' }] } });
  await flush();
  child.stdout.emit('data', JSON.stringify({ type: 'response', id: 'p1', success: true }) + '\n');
  await flush();

  // Now pi produces one line bigger than the 16 MB limit — no trailing newline needed to trip it.
  child.stdout.emit('data', 'x'.repeat(16 * 1024 * 1024 + 1));
  await flush();

  const promptReply = out.find((m) => m.id === 3);
  assert.ok(promptReply, 'the hung session/prompt call was resolved, not left pending');
  assert.equal(promptReply.result.stopReason, 'refusal');
  assert.ok(out.some((m) => m.id === null && m.error), 'a JSON-RPC error was sent to the client');
  assert.ok(logs.some((l) => /oversized/i.test(l) || /buffer/i.test(l)), 'the size was logged');
  assert.ok(child.killCalls.length > 0, 'pi was killed once its session failed');
  void bridge;
});

test('the ask() to noevia times out (default matches the web gate) and pi is unblocked as refused', async () => {
  const child = fakePi();
  const { send } = harness({ spawnFn: () => child, askTimeoutMs: 20 });
  send({ id: 1, method: 'session/new', params: { cwd: '/task' } });
  await flush();
  // pi asks a confirm-style extension_ui_request; the client (noevia) never answers it.
  const payload = JSON.stringify({ noevia: 'tool_call', toolCallId: 'c1', toolName: 'bash', input: { command: 'ls' } });
  child.stdout.emit('data', JSON.stringify({ type: 'extension_ui_request', id: 'ui1', method: 'confirm', message: payload }) + '\n');
  await new Promise((r) => setTimeout(r, 60));
  const response = child.stdin.writes.map((w) => JSON.parse(w)).find((m) => m.type === 'extension_ui_response' && m.id === 'ui1');
  assert.ok(response, 'pi got an answer instead of waiting forever');
  assert.equal(response.confirmed, false, 'an unanswered ask() times out as a refusal');
});

test('a late reply for an already-timed-out ask() is dropped, not applied', async () => {
  const child = fakePi();
  const { send, out } = harness({ spawnFn: () => child, askTimeoutMs: 15 });
  send({ id: 1, method: 'session/new', params: { cwd: '/task' } });
  await flush();
  const payload = JSON.stringify({ noevia: 'tool_call', toolCallId: 'c1', toolName: 'bash', input: { command: 'ls' } });
  child.stdout.emit('data', JSON.stringify({ type: 'extension_ui_request', id: 'ui1', method: 'confirm', message: payload }) + '\n');
  await new Promise((r) => setTimeout(r, 40)); // well past the timeout
  const requestToClient = out.find((m) => m.method === 'session/request_permission');
  assert.ok(requestToClient, 'the request reached the client before the timeout fired');
  // The client answers "allow" anyway, long after the bridge gave up on it.
  send({ id: requestToClient.id, result: { outcome: { outcome: 'selected', optionId: 'allow_once' } } });
  await flush();
  const responses = child.stdin.writes.map((w) => JSON.parse(w)).filter((m) => m.type === 'extension_ui_response' && m.id === 'ui1');
  assert.equal(responses.length, 1, 'only the timeout answer was ever sent to pi');
  assert.equal(responses[0].confirmed, false, 'the late "allow" never overturned the timeout refusal');
});

test('pi is spawned detached and killed via its process group, with a SIGKILL fallback', async () => {
  const killedGroups = [];
  const realKill = process.kill.bind(process);
  process.kill = (pid, sig) => { killedGroups.push([pid, sig]); if (pid < 0) return; return realKill(pid, sig); };
  try {
    const child = fakePi({ pid: 777 });
    let detachedFlag = null;
    const spawnFn = (cmd, args, opts) => { detachedFlag = opts.detached; return child; };
    const { send } = harness({ spawnFn, askTimeoutMs: 10 });
    send({ id: 1, method: 'session/new', params: { cwd: '/task' } });
    await flush();
    assert.equal(detachedFlag, true, 'pi is spawned with its own process group');
    // End of task: the client stream closes.
    send.toBridgeEnd?.();
  } finally {
    process.kill = realKill;
  }
  // Rerun with an explicit end() to check group-kill targeting.
  const killedGroups2 = [];
  const realKill2 = process.kill.bind(process);
  process.kill = (pid, sig) => { killedGroups2.push([pid, sig]); };
  try {
    const child = fakePi({ pid: 999 });
    const { toBridge } = harness({ spawnFn: () => child, askTimeoutMs: 10 });
    toBridge.write(JSON.stringify({ id: 1, method: 'session/new', params: { cwd: '/task' } }) + '\n');
    await flush();
    toBridge.end();
    await flush();
    assert.ok(killedGroups2.some(([pid, sig]) => pid === -999 && sig === 'SIGTERM'),
      'the negative pid targets the whole process group, not just pi itself');
  } finally {
    process.kill = realKill2;
  }
});

test('an outside-the-workspace read from the gate goes to noevia as an ask that cannot stand (#113)', () => {
  const { toolCallFor } = require('./pi-acp-bridge.cjs');
  const { classify, decide } = require('../../apps/web/server/code-actions.cjs');
  const inside = toolCallFor({ toolCallId: 'a', toolName: 'read', input: { path: 'src/a.ts' } });
  assert.equal(inside.kind, 'read');
  assert.equal(decide({ classified: classify(inside) }).decision, 'allow');
  const outside = toolCallFor({ toolCallId: 'b', toolName: 'read', input: { path: '/etc/passwd' }, outsideWorkspace: true });
  assert.equal(outside.kind, 'other');
  const c = classify(outside);
  assert.equal(decide({ classified: c }).decision, 'ask');
  assert.equal(c.standable, false);
});
