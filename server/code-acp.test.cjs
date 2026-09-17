'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { connectAcp, createLineReader } = require('./code-acp.cjs');

const AGENT = require.resolve('./fixtures/fake-acp-agent.cjs');
const temps = [];
const temp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-acp-')); temps.push(d); return d; };
test.after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });

function handlers(overrides = {}) {
  const seen = { updates: [], permissions: [], reads: [], writes: [] };
  return [{
    requestPermission: async (p) => { seen.permissions.push(p); return { outcome: 'selected', optionId: 'y' }; },
    readTextFile: async (p) => { seen.reads.push(p); return { content: 'file body' }; },
    writeTextFile: async (p) => { seen.writes.push(p); return null; },
    sessionUpdate: (u) => { seen.updates.push(u); },
    ...overrides,
  }, seen];
}
const connect = (script, { handlers: overrides, env = {}, ...rest } = {}) => {
  const [h, seen] = handlers(overrides);
  const cwd = temp();
  // `env` is merged into the agent's script rather than replacing it: an earlier version
  // spread the whole options object last and silently dropped SCRIPT, so the "hung agent"
  // test was really running an agent that answered immediately.
  return connectAcp({ command: process.execPath, args: [AGENT], cwd, handlers: h, graceMs: 50,
    env: { SCRIPT: JSON.stringify(script), ...env }, ...rest })
    .then((agent) => ({ agent, seen, cwd }));
};

test('lines are framed one JSON message each, and junk does not derail the stream', () => {
  const got = [], bad = [];
  const feed = createLineReader((m) => got.push(m), (e) => bad.push(e.message));
  feed('{"a":1}\n{"b"');
  feed(':2}\n');
  feed('not json\n');
  feed('\n{"c":3}\n');
  assert.deepEqual(got, [{ a: 1 }, { b: 2 }, { c: 3 }]);
  assert.equal(bad.length, 1);
});

test('an oversized line is dropped rather than buffered without bound', () => {
  const got = [], bad = [];
  const feed = createLineReader((m) => got.push(m), (e) => bad.push(e.message));
  feed('x'.repeat(17 * 1024 * 1024));
  feed('{"after":1}\n');
  assert.deepEqual(got, [{ after: 1 }], 'the stream recovers on the next line');
  assert.match(bad[0], /oversized/);
});

test('a prompt runs, updates reach the handlers and the result comes back', async () => {
  const { agent, seen } = await connect([
    { update: { sessionUpdate: 'tool_call', toolCallId: '1', kind: 'read', title: 'Read a.txt' } },
    { update: { sessionUpdate: 'tool_call_update', toolCallId: '1', status: 'completed' } },
  ]);
  const result = await agent.prompt('do the thing');
  assert.equal(result.stopReason, 'end_turn');
  assert.deepEqual(seen.updates.map((u) => u.sessionUpdate), ['tool_call', 'tool_call_update']);
});

test('the agent’s permission request is answered by noevia’s handler, verbatim', async () => {
  const { agent, seen } = await connect([{ permission: { toolCall: { kind: 'edit', title: 'Edit a.txt' }, options: [{ optionId: 'y', kind: 'allow_once' }] } }]);
  const result = await agent.prompt('edit');
  assert.equal(seen.permissions.length, 1);
  assert.equal(seen.permissions[0].toolCall.kind, 'edit');
  assert.deepEqual(result.seen[0].result, { outcome: 'selected', optionId: 'y' });
});

test('a handler refusal reaches the agent as a JSON-RPC error, not as a result', async () => {
  const { agent } = await connect([{ write: { path: '/etc/passwd', content: 'x' } }], {
    handlers: { writeTextFile: async () => { throw Object.assign(Error('Outside this task’s workspace'), { code: -32602 }); } },
  });
  const result = await agent.prompt('write');
  assert.equal(result.seen[0].result, undefined);
  assert.equal(result.seen[0].error.code, -32602);
  assert.match(result.seen[0].error.message, /Outside/);
});

test('a method this client does not implement is answered, never ignored', async () => {
  const { agent } = await connect([{ unknown: true }]);
  const result = await agent.prompt('x');
  assert.equal(result.seen[0].error.code, -32601, 'an ignored request would hang the agent');
});

test('the agent inherits no ambient environment, and gets the proxy only when granted', async () => {
  process.env.NOEVIA_ACP_SECRET_PROBE = 'must-not-leak';
  try {
    const bare = await connect([{ env: 'NOEVIA_ACP_SECRET_PROBE' }, { env: 'HTTPS_PROXY' }]);
    await bare.agent.prompt('x');
    assert.deepEqual(bare.seen.updates.map((u) => u.env), [null, null], 'no secrets, no proxy');

    const granted = await connect([{ env: 'HTTPS_PROXY' }], { proxy: { url: 'http://task:token@egress' } });
    await granted.agent.prompt('x');
    assert.equal(granted.seen.updates[0].env, 'http://task:token@egress');
  } finally { delete process.env.NOEVIA_ACP_SECRET_PROBE; }
});

test('HOME is the worktree, so the agent writes its own state inside the sandbox', async () => {
  const { agent, seen, cwd } = await connect([{ env: 'HOME' }]);
  await agent.prompt('x');
  assert.equal(seen.updates[0].env, cwd);
});

test('the pinned permission config is what the session is opened with', async () => {
  const { agent } = await connect([], { permission: { edit: 'ask', bash: 'ask', webfetch: 'ask' } });
  // The fake agent reports back what it saw on session/new.
  assert.ok(agent.sessionId);
  const result = await agent.prompt('x');
  assert.equal(result.stopReason, 'end_turn');
});

test('an agent error becomes a rejected prompt, and the subprocess is stopped', async () => {
  const { agent } = await connect([{ fail: 'the model refused' }]);
  await assert.rejects(() => agent.prompt('x'), /the model refused/);
});

test('cancelling stops an agent that never answers, even one ignoring session/cancel', async () => {
  for (const ignore of [false, true]) {
    const controller = new AbortController();
    const { agent } = await connect([{ hang: true }], { signal: controller.signal, env: ignore ? { IGNORE_CANCEL: '1' } : {} });
    const running = agent.prompt('x');
    const settled = running.then(() => 'resolved', () => 'rejected');
    setTimeout(() => controller.abort(), 50);
    assert.equal(await settled, 'rejected', `ignore_cancel=${ignore}: a hung task must not hang the server`);
  }
});

test('an agent that dies during the handshake is refused rather than driven blind', async () => {
  await assert.rejects(() => connectAcp({ command: process.execPath, args: ['-e', 'setTimeout(()=>process.exit(3),20)'],
    cwd: temp(), handlers: handlers()[0], graceMs: 50 }), /exited|session/i);
});

test('an agent that never answers the handshake times out instead of holding the task', async () => {
  const started = Date.now();
  await assert.rejects(() => connectAcp({ command: process.execPath, args: ['-e', 'process.stdin.resume()'],
    cwd: temp(), handlers: handlers()[0], graceMs: 50, handshakeMs: 100 }), /did not answer/);
  assert.ok(Date.now() - started < 5000, 'it gives up quickly, not never');
});

test('cancelling during the handshake stops the agent, with no session to cancel', async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(() => connectAcp({ command: process.execPath, args: ['-e', 'process.stdin.resume()'],
    cwd: temp(), handlers: handlers()[0], graceMs: 50, handshakeMs: 10000, signal: controller.signal }), /Cancelled|did not answer/);
});

test('a signal already aborted never starts a prompt at all', async () => {
  await assert.rejects(() => connectAcp({ command: process.execPath, args: [AGENT], cwd: temp(),
    handlers: handlers()[0], graceMs: 50, signal: AbortSignal.abort() }), /Cancelled/);
});

test('a missing command is a clear configuration error, not a crash', async () => {
  await assert.rejects(() => connectAcp({ command: '', cwd: temp(), handlers: handlers()[0] }), /No coding harness is configured/);
});
