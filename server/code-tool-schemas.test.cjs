'use strict';
// The Executor guard (#704): per-action schemas at the ACP boundary, the structured violation the
// agent gets back, the three-strike block, and that nothing changes with the flag off.
// Synthetic repositories and a scripted agent only; no model, no network.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createCodeHarness } = require('./code-harness.cjs');
const { createCodeWorkspaces } = require('./code-workspace.cjs');
const { createJobs } = require('./jobs.cjs');
const { connectAcp } = require('./code-acp.cjs');
const { ACTIONS } = require('./code-actions.cjs');
const {
  MAX_VIOLATIONS, ACP_KINDS, checkToolCall, checkFsCall, createExecutorGuard, executorGuardFlag, useExecutorGuard,
} = require('./code-tool-schemas.cjs');

const AGENT = require.resolve('./fixtures/fake-acp-agent.cjs');
const temps = [];
const temp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); temps.push(d); return d; };
test.after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });

function repo() {
  const dir = temp('noevia-grepo-');
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 'qa@example.invalid'); git('config', 'user.name', 'QA');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\nb\nc'); git('add', '.'); git('commit', '-qm', 'first');
  return dir;
}

const OPTIONS = [{ optionId: 'y', kind: 'allow_once' }, { optionId: 'ya', kind: 'allow_always' },
  { optionId: 'n', kind: 'reject_once' }, { optionId: 'na', kind: 'reject_always' }];
const ON = { enabled: () => true }, OFF = { enabled: () => false };
const ROOT = '/work/tree';

// ── The schemas, on their own ────────────────────────────────────────────────────────────────

test('well-formed calls from the harnesses noevia runs pass every schema', () => {
  const ok = [
    // OpenCode, measured in experiments/acp-spike (removed in #846; git history at cc1bc4a9): an edit names `filepath` + `diff` and a location.
    { toolCallId: 'c1', kind: 'edit', title: `${ROOT}/median.js`, locations: [{ path: `${ROOT}/median.js` }], rawInput: { filepath: `${ROOT}/median.js`, diff: '@@' } },
    { toolCallId: 'c2', kind: 'execute', title: 'node test.js', rawInput: { command: 'node test.js', cwd: ROOT } },
    // pi bridge: bash as `execute`, write as `edit` with `path`, grep as `search`.
    { toolCallId: 'pi-bash', kind: 'execute', title: 'ls', rawInput: { command: 'ls -la' } },
    { toolCallId: 'pi-write', kind: 'edit', title: 'write', rawInput: { path: 'src/x.js', content: 'x'.repeat(100000) }, locations: [{ path: 'src/x.js' }] },
    { toolCallId: 'pi-grep', kind: 'search', title: 'grep', rawInput: { pattern: 'TODO', path: '.' } },
    { toolCallId: 'r', kind: 'read', rawInput: { filePath: `${ROOT}/a.txt` }, locations: [{ path: `${ROOT}/a.txt`, line: 3 }] },
    { kind: 'think', title: 'Thinking' },
    { kind: 'fetch', rawInput: { url: 'https://registry.npmjs.org/x' } },
    { kind: 'execute', rawInput: { command: ['npm', 'test'] } },
    { kind: 'other', title: 'todowrite', rawInput: { todos: [{ content: 'x' }] } },
    { toolCallId: 'only-id' },
  ];
  for (const call of ok) assert.equal(checkToolCall(call), null, JSON.stringify(call).slice(0, 80));
});

test('each malformed call names the argument that is wrong, with a hint for its kind', () => {
  const bad = [
    [{ kind: 'execute', rawInput: {} }, '$.rawInput.command', /Missing command/],
    [{ kind: 'execute' }, '$.rawInput.command', /Missing command/],
    [{ kind: 'execute', rawInput: { command: 42 } }, '$.rawInput.command', /expected string \| array/],
    [{ kind: 'execute', rawInput: { command: 'ls', cwd: '' } }, '$.rawInput.cwd', /Empty path/],
    [{ kind: 'execute', rawInput: 'rm -rf /' }, '$.rawInput', /expected object/],
    [{ kind: 'edit', title: 'Edit', rawInput: { content: 'x' } }, '$.locations', /names no file/],
    [{ kind: 'edit', locations: [{ path: 'src/a\nb.js' }] }, '$.locations[0].path', /control character/],
    [{ kind: 'edit', locations: [{ line: 1 }] }, '$.locations[0]', /Missing required property path/],
    [{ kind: 'edit', locations: 'a.txt' }, '$.locations', /expected array/],
    [{ kind: 'delete', rawInput: { path: '' } }, '$.rawInput.path', /Empty path/],
    [{ kind: 'move', rawInput: { path: 'a\0b' } }, '$.rawInput.path', /NUL/],
    [{ kind: 'read', locations: [{ path: 'a\u001b[2Jb' }] }, '$.locations[0].path', /control character/],
    [{ kind: 'fetch', rawInput: { url: 42 } }, '$.rawInput.url', /expected string/],
    [{ kind: 'fetch', rawInput: {} }, '$.rawInput.url', /Missing URL/],
    [{ kind: 'launch_missiles', rawInput: { command: 'ls' } }, '$.kind', /Unknown tool kind/],
    [{ kind: 'think', toolCallId: 7 }, '$.toolCallId', /expected string/],
    [{ kind: 'other', rawInput: { path: ['a', 'b'] } }, '$.rawInput.path', /expected string/],
    [{ kind: 'execute', rawInput: { command: 'x'.repeat(64 * 1024 + 1) } }, '$.rawInput.command', /maxLength/],
  ];
  for (const [call, at, message] of bad) {
    const found = checkToolCall(call);
    assert.ok(found, JSON.stringify(call));
    assert.equal(found.path, at, JSON.stringify(call));
    assert.match(found.message, message, JSON.stringify(call));
    assert.ok(found.hint, 'a hint the agent can act on');
  }
  assert.ok(ACP_KINDS.includes('switch_mode') && ACP_KINDS.length === 10);
});

test('where a call points is never a strike: reads, writes, commands and fetches anywhere pass the shape check', () => {
  // The policy behind the guard owns these: decide() refuses a write/move/delete outside the
  // workspace, a read or command elsewhere goes to the card (#113), and fs/* is checked on use.
  const elsewhere = [
    { kind: 'read', locations: [{ path: '../../outside.txt' }] },
    { kind: 'other', title: 'read outside the workspace', locations: [{ path: '/home/agent/.ssh/id_rsa' }], rawInput: { path: '/home/agent/.ssh/id_rsa', noeviaOutsideWorkspace: true } },
    { kind: 'edit', locations: [{ path: '/etc/passwd' }] },
    { kind: 'delete', rawInput: { path: '/etc/passwd' } },
    { kind: 'execute', rawInput: { command: 'ls', cwd: '/etc' } },
    { kind: 'fetch', rawInput: { url: 'file:///etc/passwd' } },
  ];
  for (const call of elsewhere) assert.equal(checkToolCall(call), null, JSON.stringify(call));
  assert.equal(checkFsCall('fs/read_text_file', { path: '/etc/shadow' }), null);
  assert.equal(checkFsCall('fs/write_text_file', { path: '../escape.txt', content: 'x' }), null);
});

test('fs/read_text_file and fs/write_text_file params have their own schemas', () => {
  const opts = { maxBytes: 16 };
  assert.equal(checkFsCall('fs/read_text_file', { sessionId: 's', path: `${ROOT}/a.txt`, line: 2, limit: 1 }, opts), null);
  assert.equal(checkFsCall('fs/write_text_file', { sessionId: 's', path: 'b.txt', content: 'hello' }, opts), null);
  const cases = [
    ['fs/read_text_file', {}, '$', /Missing required property path/],
    ['fs/read_text_file', null, '$', /expected object/],
    ['fs/read_text_file', { path: 5 }, '$.path', /expected string/],
    ['fs/read_text_file', { path: '' }, '$.path', /Empty path/],
    ['fs/read_text_file', { path: 'a\u0000.txt' }, '$.path', /control character/],
    ['fs/read_text_file', { path: 'a.txt', line: 0 }, '$.line', /1 or more/],
    ['fs/read_text_file', { path: 'a.txt', limit: 2.5 }, '$.limit', /integer/],
    ['fs/write_text_file', { path: 'b.txt' }, '$', /Missing required property content/],
    ['fs/write_text_file', { path: 'b.txt', content: { text: 'x' } }, '$.content', /expected string/],
    ['fs/write_text_file', { path: 'b.txt', content: 'x'.repeat(17) }, '$.content', /larger than 16 bytes/],
    ['fs/write_text_file', { path: 'a\tb.txt', content: 'x' }, '$.path', /control character/],
  ];
  for (const [method, params, at, message] of cases) {
    const found = checkFsCall(method, params, opts);
    assert.ok(found, `${method} ${JSON.stringify(params)}`);
    assert.equal(found.path, at, `${method} ${JSON.stringify(params)}`);
    assert.match(found.message, message);
  }
});

test('the guard counts shape violations, gives each its structured correction, and blocks at the limit', () => {
  const events = [], logs = [];
  let halted = 0;
  const guard = createExecutorGuard({ event: (type, data) => events.push({ type, data }), log: (e) => logs.push(e), onBlocked: () => halted++ });
  assert.equal(guard.permission({ kind: 'execute', rawInput: { command: 'ls' } }), null, 'a good call passes and is not counted');
  assert.equal(guard.readTextFile({ path: '/etc/hosts' }), null, 'a read elsewhere is not a strike');
  const v1 = guard.permission({ kind: 'execute', rawInput: {} }, ACTIONS.EXECUTE);
  assert.deepEqual(v1.violation, { message: 'Missing command at $.rawInput.command', path: '$.rawInput.command' });
  assert.equal(v1.type, 'schema_violation_correction', 'the Laya correction shape');
  assert.equal(v1.tool, 'session/request_permission');
  assert.deepEqual([v1.count, v1.limit, v1.blocked], [1, MAX_VIOLATIONS, false]);
  const decided = events.find((e) => e.type === 'approval.decided');
  assert.equal(decided.data.decision, 'denied');
  assert.equal(decided.data.automatic, true);
  assert.equal(decided.data.action, ACTIONS.EXECUTE);
  assert.match(decided.data.reason, /violation 1 of 3\). Correct the arguments and call the tool again. Missing command at \$\.rawInput\.command\. Send the shell command/);
  assert.deepEqual(decided.data.violation, v1);

  const second = guard.readTextFile({ path: 5 });
  assert.equal(second.code, -32602, 'an fs call has no reject outcome: it is an Invalid-params error');
  assert.equal(second.data.noeviaViolation.count, 2);
  assert.deepEqual(JSON.parse(second.message.split('\n')[1]).noeviaViolation, second.data.noeviaViolation, 'the message carries the same structure');
  const third = guard.writeTextFile({ path: 'x' });
  assert.equal(third.data.noeviaViolation.blocked, true);
  assert.match(third.message, /stopped the task/);
  assert.equal(guard.blocked, true);
  assert.equal(halted, 1);
  const step = events.filter((e) => e.type.startsWith('step.'));
  assert.deepEqual(step.map((e) => e.type), ['step.started', 'step.completed']);
  assert.equal(step[1].data.blocked, true);

  // Once blocked, even a good call is refused, and nothing more is counted or halted.
  const after = guard.permission({ kind: 'execute', rawInput: { command: 'ls' } });
  assert.equal(after.blocked, true);
  assert.equal(guard.violations, 3);
  assert.equal(halted, 1);
  const blocked = guard.blockedError();
  assert.equal(blocked.result.blocked, true);
  assert.equal(blocked.result.reason, 'executor_guard');
  assert.equal(blocked.result.violations.length, 3);
  assert.ok(logs.every((e) => !('content' in e)), 'the log never carries file content');
});

test('the deployment flag is off until installed, and off whenever its check misbehaves', () => {
  assert.equal(executorGuardFlag.enabled(), false);
  try {
    useExecutorGuard(() => true); assert.equal(executorGuardFlag.enabled(), true);
    useExecutorGuard(() => 'yes'); assert.equal(executorGuardFlag.enabled(), false);
    useExecutorGuard(() => { throw Error('no store'); }); assert.equal(executorGuardFlag.enabled(), false);
    assert.throws(() => useExecutorGuard(true), TypeError);
  } finally { useExecutorGuard(() => false); }
});

// ── In the harness, with a scripted agent ─────────────────────────────────────────────────────

async function waitDone(jobs, taskId) {
  for (let i = 0; i < 400 && !['completed', 'failed', 'cancelled'].includes(jobs.get(taskId)?.status); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  return jobs.get(taskId);
}

/** One task; `script(handlers, cwd, signal)` plays the agent; `answers` are the person's. */
async function run({ guard, script, answers = [], capabilities = [] }) {
  const dir = temp('noevia-gjobs-');
  const jobs = createJobs({ dir });
  const workspaces = createCodeWorkspaces({ dir, epoch: 'test' });
  const asked = [], logs = [];
  let signal = null;
  const harness = createCodeHarness({
    jobs, workspaces, guard, log: (e) => logs.push(e),
    engine: () => ({ baseUrl: 'http://engine.test/v1', model: 'synthetic-coder', apiKey: null, contextTokens: 8192 }),
    askApproval: async (request) => { asked.push(request); return answers.shift() ?? 'deny'; },
  });
  const started = await harness.start({
    repoPath: repo(), prompt: 'fix the bug', capabilities,
    connect: async (args) => {
      signal = args.signal;
      return { agent: {}, prompt: async () => {
        await script(args.handlers, args.cwd, args.signal);
        if (args.signal.aborted) throw Object.assign(Error('Cancelled'), { publicMessage: 'The task was cancelled.' });
        return { stopReason: 'end_turn' };
      } };
    },
  });
  const job = await waitDone(jobs, started.taskId);
  return { ...started, jobs, job, asked, logs, signal };
}
const attempt = async (fn) => { try { return { value: await fn() }; } catch (error) { return { error }; } };

test('bad then corrected arguments: the bad call gets the reject outcome with its violation, the corrected one reaches the approval card', async () => {
  const outcomes = [];
  const r = await run({
    guard: ON, answers: ['approve'],
    script: async (h) => {
      outcomes.push(await attempt(() => h.requestPermission({ toolCall: { toolCallId: 'c1', kind: 'execute', title: 'bash', rawInput: { description: 'run the tests' } }, options: OPTIONS })));
      outcomes.push(await attempt(() => h.requestPermission({ toolCall: { toolCallId: 'c2', kind: 'execute', title: 'npm test', rawInput: { command: 'npm test' } }, options: OPTIONS })));
    },
  });
  assert.equal(outcomes[0].error, undefined, 'an ordinary refusal, not a protocol error');
  assert.equal(outcomes[0].value.outcome, 'selected');
  assert.equal(outcomes[0].value.optionId, 'n', 'the reject_once option, as a Decline sends');
  assert.equal(outcomes[0].value._meta.noevia.violation.violation.path, '$.rawInput.command');
  assert.match(outcomes[0].value._meta.noevia.reason, /Missing command/);
  assert.deepEqual(outcomes[1].value, { outcome: 'selected', optionId: 'y' });
  assert.equal(r.asked.length, 1, 'only the corrected call was put in front of the person');
  assert.equal(r.asked[0].command, 'npm test');
  assert.equal(r.job.status, 'completed');
  assert.equal(r.job.result.violations, 1);
  assert.equal(r.job.result.denied, 1);
  assert.ok(r.logs.some((e) => e.event === 'code.guard_violation' && e.count === 1));
});

test('the guard never approves: a well-formed write still asks, and Decline and a timeout still refuse', async () => {
  const picks = [];
  const r = await run({
    guard: ON, answers: ['deny', 'timeout', 'approve_all'],
    script: async (h, cwd) => {
      const edit = () => ({ toolCall: { kind: 'edit', title: 'Edit a.txt', locations: [{ path: path.join(cwd, 'a.txt') }], rawInput: { path: path.join(cwd, 'a.txt') } }, options: OPTIONS });
      picks.push(await h.requestPermission(edit()));
      picks.push(await h.requestPermission(edit()));
      picks.push(await h.requestPermission(edit()));
      picks.push(await h.requestPermission(edit())); // "Allow for this task" stands, as before
    },
  });
  assert.equal(r.asked.length, 3);
  assert.deepEqual(picks.map((p) => p.optionId), ['n', 'n', 'y', 'y']);
  assert.equal(r.job.result.violations, 0);
});

test('malformed fs calls are refused by the guard; good ones run; one outside the worktree is refused as before, without a strike', async () => {
  const out = [];
  const r = await run({
    guard: ON,
    script: async (h, cwd) => {
      out.push(await attempt(() => h.readTextFile({ sessionId: 's', path: path.join(cwd, 'a.txt'), line: 2, limit: 1 })));
      out.push(await attempt(() => h.writeTextFile({ sessionId: 's', path: path.join(cwd, 'b.txt') })));
      out.push(await attempt(() => h.writeTextFile({ sessionId: 's', path: path.join(cwd, 'b.txt'), content: 'fixed' })));
      out.push(await attempt(() => h.readTextFile({ sessionId: 's', path: '/etc/passwd' })));
      out.push(await attempt(() => h.writeTextFile({ sessionId: 's', path: path.join(cwd, '..', 'escape.txt'), content: 'x' })));
    },
  });
  assert.deepEqual(out[0].value, { content: 'b' });
  assert.equal(out[1].error.code, -32602);
  assert.equal(out[1].error.data.noeviaViolation.tool, 'fs/write_text_file');
  assert.equal(out[1].error.data.noeviaViolation.violation.message, 'Missing required property content at $');
  assert.equal(out[2].value, null);
  assert.equal(out[3].error.message, 'Outside this task’s workspace', 'the harness’s own refusal, unchanged');
  assert.equal(out[3].error.data, undefined);
  assert.equal(out[4].error.message, 'Outside this task’s workspace');
  assert.equal(r.job.status, 'completed');
  assert.equal(r.job.result.violations, 1, 'only the malformed call was a strike');
});

test('pointing outside the workspace is never a strike: the out-of-workspace read still reaches the card (#113), an outside write is refused as before', async () => {
  const picks = [];
  const r = await run({
    guard: ON, answers: ['approve', 'approve', 'approve'],
    script: async (h, cwd) => {
      // pi's bridge sends a read outside the tree as `other`, flagged: a person decides it.
      picks.push(await h.requestPermission({ toolCall: { toolCallId: 'pi-read', kind: 'other', title: 'read outside the workspace',
        locations: [{ path: '/usr/share/dict/words' }], rawInput: { path: '/usr/share/dict/words', noeviaOutsideWorkspace: true } }, options: OPTIONS }));
      picks.push(await h.requestPermission({ toolCall: { kind: 'execute', rawInput: { command: 'ls', cwd: '/tmp' } }, options: OPTIONS }));
      for (let i = 0; i < 3; i++) picks.push(await h.requestPermission({ toolCall: { kind: 'edit', locations: [{ path: '/etc/passwd' }] }, options: OPTIONS }));
      picks.push(await h.requestPermission({ toolCall: { kind: 'edit', locations: [{ path: path.join(cwd, 'a.txt') }] }, options: OPTIONS }));
    },
  });
  assert.equal(r.asked.length, 3, 'the outside read, the command and the good edit each reached the card');
  assert.equal(r.asked[0].paths[0], '/usr/share/dict/words');
  assert.deepEqual(picks.map((p) => p.optionId), ['y', 'y', 'n', 'n', 'n', 'y']);
  assert.ok(picks.every((p) => !p._meta), 'policy refusals carry no guard violation');
  assert.equal(r.job.status, 'completed', 'three outside writes did not block the task');
  assert.equal(r.job.result.violations, 0);
});

test('a malformed call answered with the reject outcome never runs its tool', async () => {
  // A scripted agent that does what a harness does: runs the edit only when allowed.
  const r = await run({
    guard: ON, answers: ['approve'],
    script: async (h, cwd) => {
      const target = path.join(cwd, 'a.txt');
      const malformed = await h.requestPermission({ toolCall: { kind: 'edit', title: 'Edit a.txt', rawInput: { content: 'CLOBBERED' } }, options: OPTIONS });
      if (malformed.outcome === 'selected' && malformed.optionId === 'y') await h.writeTextFile({ path: target, content: 'CLOBBERED' });
      assert.equal(fs.readFileSync(target, 'utf8'), 'a\nb\nc', 'the file is untouched');
    },
  });
  assert.equal(r.asked.length, 0, 'never offered to the person either');
  assert.equal(r.job.status, 'completed');
  assert.equal(r.job.result.denied, 1);
});

test('three violations stop the task as blocked: the agent is halted and no card is ever shown', async () => {
  const out = [];
  const r = await run({
    guard: ON, answers: ['approve', 'approve'],
    script: async (h, cwd, signal) => {
      out.push(await attempt(() => h.requestPermission({ toolCall: { kind: 'execute', rawInput: {} }, options: OPTIONS })));
      out.push(await attempt(() => h.readTextFile({ path: 42 })));
      out.push(await attempt(() => h.requestPermission({ toolCall: { kind: 'edit', rawInput: {} }, options: OPTIONS })));
      // The agent tries again with a perfectly good call: too late.
      out.push(await attempt(() => h.requestPermission({ toolCall: { kind: 'edit', locations: [{ path: path.join(cwd, 'a.txt') }] }, options: OPTIONS })));
      await new Promise((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); });
    },
  });
  const violationOf = (o) => o.value?._meta?.noevia?.violation || o.error?.data?.noeviaViolation;
  assert.deepEqual(out.map((o) => violationOf(o)?.count), [1, 2, 3, 3]);
  assert.deepEqual(out.map((o) => violationOf(o)?.blocked), [false, false, true, true]);
  assert.deepEqual([out[0], out[2], out[3]].map((o) => o.value.optionId), ['n', 'n', 'n'], 'permissions answered with the reject outcome');
  assert.equal(r.asked.length, 0, 'nothing reached the person, and nothing was allowed');
  assert.equal(r.signal.aborted, true, 'the agent was stopped');
  assert.equal(r.job.status, 'failed');
  assert.equal(r.job.lifecycle, 'blocked');
  assert.match(r.job.error, /^Blocked: the coding agent sent 3 malformed tool calls/);
  assert.equal(r.job.result.blocked, true);
  assert.equal(r.job.result.reason, 'executor_guard');
  assert.deepEqual(r.job.result.violations.map((v) => v.tool), ['session/request_permission', 'fs/read_text_file', 'session/request_permission']);
  const step = r.job.steps.find((s) => s.id === 'executor.guard');
  assert.equal(step.status, 'failed');
});

test('a blocked task stays blocked even when the agent ignores the stop and finishes its turn', async () => {
  const r = await run({
    guard: ON,
    script: async (h) => {
      for (let i = 0; i < 3; i++) await attempt(() => h.requestPermission({ toolCall: { kind: 'fetch', rawInput: {} }, options: OPTIONS }));
    },
  });
  // The halt lands on the next turn of the event loop, after this agent has already answered
  // end_turn: the harness still ends the task as blocked rather than completed.
  assert.equal(r.job.status, 'failed');
  assert.equal(r.job.result.blocked, true);
});

test('flag off: the same malformed calls take exactly the path they took before', async () => {
  const out = [];
  const r = await run({
    guard: OFF, answers: ['deny', 'deny', 'deny'],
    script: async (h, cwd) => {
      for (let i = 0; i < 3; i++) out.push(await attempt(() => h.requestPermission({ toolCall: { kind: 'execute', rawInput: {} }, options: OPTIONS })));
      out.push(await attempt(() => h.readTextFile({ path: '/etc/passwd' })));
      out.push(await attempt(() => h.writeTextFile({ path: path.join(cwd, 'c.txt') })));
    },
  });
  assert.equal(r.asked.length, 3, 'the unreadable command still goes to the person');
  assert.equal(r.asked[0].reason, 'The harness did not say what it would run.');
  assert.deepEqual(out.slice(0, 3).map((o) => o.value?.optionId), ['n', 'n', 'n']);
  assert.equal(out[3].error.message, 'Outside this task’s workspace');
  assert.equal(out[3].error.data, undefined);
  assert.equal(out[4].value, null, 'a write with no content still writes an empty file, as before');
  assert.equal(r.job.status, 'completed');
  assert.equal('violations' in r.job.result, false, 'no new field in the result');
  assert.equal(r.job.steps.some((s) => s.id === 'executor.guard'), false);
});

test('the deployment default is off: a harness built without a guard runs unguarded', async () => {
  const r = await run({
    guard: undefined, answers: ['deny'],
    script: async (h) => { await h.requestPermission({ toolCall: { kind: 'execute', rawInput: {} }, options: OPTIONS }); },
  });
  assert.equal(r.asked.length, 1);
  assert.equal('violations' in r.job.result, false);
});

// ── Over a real ACP connection (the scripted fake agent subprocess) ────────────────────────────

async function runAcp({ guard, steps, answers = [] }) {
  const dir = temp('noevia-gacp-');
  const jobs = createJobs({ dir });
  const workspaces = createCodeWorkspaces({ dir, epoch: 'test' });
  const asked = [];
  let prompt = null;
  const harness = createCodeHarness({
    jobs, workspaces, guard,
    engine: () => ({ baseUrl: 'http://engine.test/v1', model: 'synthetic-coder', apiKey: null }),
    askApproval: async (request) => { asked.push(request); return answers.shift() ?? 'deny'; },
  });
  const started = await harness.start({
    repoPath: repo(), prompt: 'fix the bug',
    connect: async (args) => {
      const agent = await connectAcp({ command: process.execPath, args: [AGENT], cwd: args.cwd, handlers: args.handlers,
        signal: args.signal, graceMs: 50, env: { SCRIPT: JSON.stringify(steps(args.cwd)) } });
      return { ...agent, agent: agent.agent, prompt: async (text) => { prompt = await agent.prompt(text); return prompt; } };
    },
  });
  const job = await waitDone(jobs, started.taskId);
  return { job, asked, seen: prompt?.seen || null };
}

test('over ACP: the violation reaches the agent as the reject outcome with the violation in _meta, and the corrected call is approved', async () => {
  const r = await runAcp({
    guard: ON, answers: ['approve'],
    steps: (cwd) => [
      { permission: { sessionId: 'session-1', toolCall: { toolCallId: 'e1', kind: 'edit', title: 'write', rawInput: { content: 'x' } }, options: OPTIONS } },
      { permission: { sessionId: 'session-1', toolCall: { toolCallId: 'e2', kind: 'edit', title: 'write', locations: [{ path: path.join(cwd, 'a.txt') }], rawInput: { filePath: path.join(cwd, 'a.txt'), content: 'x' } }, options: OPTIONS } },
      { write: { sessionId: 'session-1', path: path.join(cwd, 'a.txt'), content: 'x' } },
    ],
  });
  assert.equal(r.job.status, 'completed');
  const [bad, good, wrote] = r.seen;
  assert.equal(bad.error, undefined);
  assert.equal(bad.noeviaSaid, 'selected', 'nested as ACP requires, so the harness reads a refusal');
  assert.equal(bad.result.outcome.optionId, 'n');
  assert.equal(bad.result.outcome._meta.noevia.violation.violation.path, '$.locations');
  assert.match(bad.result.outcome._meta.noevia.reason, /names no file/);
  assert.equal(good.noeviaSaid, 'selected');
  assert.deepEqual(good.result.outcome, { outcome: 'selected', optionId: 'y' });
  assert.equal(wrote.result, null);
  assert.equal(r.asked.length, 1);
});

test('over ACP: after the third violation the agent subprocess is stopped and the task is blocked', async () => {
  const r = await runAcp({
    guard: ON,
    steps: () => [
      { permission: { sessionId: 'session-1', toolCall: { kind: 'execute', rawInput: {} }, options: OPTIONS } },
      { read: { sessionId: 'session-1', path: '' } },
      { write: { sessionId: 'session-1', path: 'notes.txt', content: 7 } },
      { hang: true },
    ],
  });
  assert.equal(r.job.status, 'failed');
  assert.equal(r.job.lifecycle, 'blocked');
  assert.equal(r.job.result.blocked, true);
  assert.equal(r.asked.length, 0);
});
