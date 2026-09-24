'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { connectAcp, createAcpTransport, createLineReader } = require('./code-acp.cjs');
const { pinFilesFor } = require('./code-harness-config.cjs');

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
  // Nested, as ACP requires — see "an approval reaches the agent as an approval" below. This
  // assertion used to encode the bug: it accepted the unwrapped shape a real harness reads as a
  // rejection.
  assert.deepEqual(result.seen[0].result, { outcome: { outcome: 'selected', optionId: 'y' } });
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

test('HOME is the task\u2019s own directory, never the workspace', async () => {
  // With HOME inside the repository a real run committed the harness's whole cache and database
  // onto the task's branch.
  const home = temp();
  const { agent, seen, cwd } = await connect([{ env: 'HOME' }], { home });
  await agent.prompt('x');
  assert.equal(seen.updates[0].env, home);
  assert.notEqual(seen.updates[0].env, cwd);
});

test('with no HOME given, none is invented', async () => {
  const { agent, seen } = await connect([{ env: 'HOME' }]);
  await agent.prompt('x');
  assert.equal(seen.updates[0].env, null, 'the sandbox supervisor supplies its own instead');
});

test('Claude sessions exclude repository settings, hooks and MCP while retaining the pinned permission config', async () => {
  const permission = { edit: 'ask', bash: 'ask', webfetch: 'ask' };
  const settings = JSON.parse(pinFilesFor({ harness: 'claude-code', model: 'fake', engine: 'http://engine.test/v1' })
    .files.find((file) => file.base === 'home').content);
  const home = temp(); fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude/settings.json'), JSON.stringify(settings));
  const { agent } = await connect([], { permission, harness: 'claude-code', home });
  // The fake agent reports back exactly what it saw on session/new.
  assert.ok(agent.sessionId);
  const result = await agent.prompt('x');
  assert.equal(result.stopReason, 'end_turn');
  assert.deepEqual(result.sessionNew._meta.noevia.permission, permission);
  assert.deepEqual(result.sessionNew._meta.claudeCode, { options: {
    settingSources: [],
    strictMcpConfig: true,
    allowDangerouslySkipPermissions: false,
    plugins: [],
    tools: ['Read', 'Edit', 'Write', 'NotebookEdit', 'Bash', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
    extraArgs: { 'disable-slash-commands': null },
    settings,
  } });
  assert.deepEqual(result.sessionNew.mcpServers, []);
});

test('Claude is refused before spawn when its private pin is unavailable', async () => {
  let spawned = false;
  await assert.rejects(() => connectAcp({ command: 'claude-agent-acp', cwd: temp(), home: temp(),
    harness: 'claude-code', handlers: handlers()[0], spawnFn: () => { spawned = true; } }), /missing or invalid/);
  assert.equal(spawned, false);
});

test('the deployment transport preserves the selected harness and its Claude session pin', async () => {
  const cwd = temp(), home = temp(), permission = { edit: 'ask', bash: 'ask', webfetch: 'ask' };
  const settings = JSON.parse(pinFilesFor({ harness: 'claude-code', model: 'fake', engine: 'http://engine.test/v1' })
    .files.find((file) => file.base === 'home').content);
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude/settings.json'), JSON.stringify(settings));
  const agent = await createAcpTransport({ command: process.execPath, args: [AGENT] })({
    cwd, home, harness: 'claude-code', permission, handlers: handlers()[0],
  });
  const result = await agent.prompt('x');
  assert.deepEqual(result.sessionNew._meta.claudeCode.options.settings, settings);
  assert.deepEqual(result.sessionNew._meta.claudeCode.options.settingSources, []);
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

test('an approval reaches the agent as an approval, not as a rejection', async () => {
  // Found by running real OpenCode: ACP nests the outcome, and sending the inner object is read
  // as "the user rejected permission". noevia said allow; the harness heard no; the edit never
  // happened. Fail-safe, and invisible until a real harness was on the other end.
  const { agent } = await connect([{ permission: { toolCall: { kind: 'edit' }, options: [{ optionId: 'y', kind: 'allow_once' }] } }]);
  const result = await agent.prompt('edit');
  const reply = result.seen[0];
  assert.deepEqual(reply.result, { outcome: { outcome: 'selected', optionId: 'y' } },
    'the outcome must be nested exactly once');
  assert.equal(reply.noeviaSaid, 'selected', 'read back the way OpenCode reads it');
});

test('a refusal is also nested, so it reads as a refusal and not as nonsense', async () => {
  const { agent } = await connect([{ permission: { toolCall: { kind: 'delete' }, options: [{ optionId: 'n', kind: 'reject_once' }] } }], {
    handlers: { requestPermission: async () => ({ outcome: 'selected', optionId: 'n' }) },
  });
  const result = await agent.prompt('delete');
  assert.deepEqual(result.seen[0].result, { outcome: { outcome: 'selected', optionId: 'n' } });
});

test('a cancelled permission is nested too', async () => {
  const { agent } = await connect([{ permission: { toolCall: { kind: 'edit' }, options: [] } }], {
    handlers: { requestPermission: async () => ({ outcome: 'cancelled' }) },
  });
  const result = await agent.prompt('edit');
  assert.deepEqual(result.seen[0].result, { outcome: { outcome: 'cancelled' } });
});

test('a proxied agent keeps the engine off the proxy, and nothing else', () => {
  const { agentEnv } = require('./code-acp.cjs');
  const env = agentEnv({ cwd: '/w', proxy: { url: 'http://task:t@egress:8040', noProxy: 'llama' } });
  assert.equal(env.HTTPS_PROXY, 'http://task:t@egress:8040');
  assert.equal(env.NO_PROXY, 'llama');
  assert.equal(agentEnv({ cwd: '/w', proxy: { url: 'http://task:t@egress' } }).NO_PROXY, '');
  assert.equal(agentEnv({ cwd: '/w' }).HTTPS_PROXY, undefined);
});

test('cancelling while an approval is pending does not crash the process with an unhandled rejection', async () => {
  const controller = new AbortController();
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    let asked;
    const askedP = new Promise((r) => { asked = r; });
    const { agent } = await connect([{ permission: { toolCall: { kind: 'edit' }, options: [{ optionId: 'n', kind: 'reject_once' }] } }, { hang: true }], {
      signal: controller.signal,
      // Like code-service: the pending approval is answered 'aborted' when the task is cancelled,
      // which resumes this handler AFTER the connection has closed.
      handlers: { requestPermission: async () => { asked(); await new Promise((r) => controller.signal.addEventListener('abort', () => setImmediate(r), { once: true })); return { outcome: 'selected', optionId: 'n' }; } },
    });
    const running = agent.prompt('edit').then(() => 'resolved', () => 'rejected');
    await askedP;
    controller.abort();
    assert.equal(await running, 'rejected');
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(unhandled, [], 'no unhandled rejection escapes');
  } finally { process.off('unhandledRejection', onUnhandled); }
});

test('the agent env pins curl and wget away from rc files in its HOME (#224)', () => {
  const { agentEnv } = require('./code-acp.cjs');
  const env = agentEnv({ cwd: '/w', home: '/h', env: { WGETRC: '/h/.wgetrc', CURL_HOME: '/h' } });
  assert.equal(env.WGETRC, '/dev/null');
  assert.equal(env.CURL_HOME, '/nonexistent');
});
