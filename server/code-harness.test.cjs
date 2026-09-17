const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createCodeHarness } = require('./code-harness.cjs');
const { createCodeWorkspaces } = require('./code-workspace.cjs');
const { createJobs } = require('./jobs.cjs');
const { ACTIONS } = require('./code-actions.cjs');

const temps = [];
const temp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); temps.push(d); return d; };
test.after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });

function repo() {
  const dir = temp('noevia-hrepo-');
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 'qa@example.invalid'); git('config', 'user.name', 'QA');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a'); git('add', '.'); git('commit', '-qm', 'first');
  return dir;
}

const OPTIONS = [{ optionId: 'y', kind: 'allow_once' }, { optionId: 'ya', kind: 'allow_always' },
  { optionId: 'n', kind: 'reject_once' }, { optionId: 'na', kind: 'reject_always' }];

/**
 * Drive one task with a scripted agent. `script` receives the session handlers and plays the
 * part of the harness; `answers` is what the human says, in order.
 */
async function run({ script, answers = [], capabilities = [], domains = [], egress = null }) {
  const dir = temp('noevia-hjobs-');
  const jobs = createJobs({ dir });
  const workspaces = createCodeWorkspaces({ dir, epoch: 'test' });
  const asked = [];
  const harness = createCodeHarness({
    jobs, workspaces, egress,
    askApproval: async (request) => { asked.push(request); return answers.shift() ?? 'deny'; },
  });
  let handlers;
  const started = await harness.start({
    repoPath: repo(), prompt: 'fix the bug', capabilities, domains,
    connect: async ({ handlers: h, cwd }) => {
      handlers = h;
      return { prompt: async () => { await script(h, cwd); return { stopReason: 'end_turn' }; } };
    },
  });
  // jobs.run is started without being awaited, so wait for the job to reach a terminal state.
  for (let i = 0; i < 200 && !['completed', 'failed', 'cancelled'].includes(jobs.get(started.taskId)?.status); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  return { ...started, dir, jobs, workspaces, job: jobs.get(started.taskId), asked, handlers };
}

const editCall = (file) => ({ toolCall: { kind: 'edit', title: 'Edit ' + file, locations: [{ path: file }], rawInput: { path: file } }, options: OPTIONS });

test('an edit inside the workspace asks, and the card carries the full arguments', async () => {
  let picked;
  const r = await run({
    answers: ['approve'],
    script: async (h, cwd) => { picked = await h.requestPermission(editCall(path.join(cwd, 'a.txt'))); },
  });
  assert.equal(r.job.status, 'completed');
  assert.equal(r.asked.length, 1);
  assert.equal(r.asked[0].action, ACTIONS.EDIT);
  assert.deepEqual(r.asked[0].arguments, { path: path.join(r.workspace, 'a.txt') }, 'arguments untruncated');
  assert.deepEqual(picked, { outcome: 'selected', optionId: 'y' });
});

test('declining means the harness is told no, not told nothing', async () => {
  let picked;
  await run({ answers: ['deny'], script: async (h, cwd) => { picked = await h.requestPermission(editCall(path.join(cwd, 'a.txt'))); } });
  assert.deepEqual(picked, { outcome: 'selected', optionId: 'n' });
});

test('a timeout or an abort is a refusal, never an allow', async () => {
  for (const answer of ['timeout', 'aborted', undefined]) {
    let picked;
    await run({ answers: [answer], script: async (h, cwd) => { picked = await h.requestPermission(editCall(path.join(cwd, 'a.txt'))); } });
    assert.deepEqual(picked, { outcome: 'selected', optionId: 'n' }, String(answer));
  }
});

test('an edit outside the workspace is refused without asking anyone', async () => {
  let picked;
  const r = await run({ script: async (h) => { picked = await h.requestPermission(editCall('/etc/passwd')); } });
  assert.equal(r.asked.length, 0, 'nobody is asked to approve what is not allowed at all');
  assert.deepEqual(picked, { outcome: 'selected', optionId: 'n' });
  const decided = events(r).find((e) => e.type === 'approval.decided');
  assert.equal(decided.data.automatic, true);
  assert.match(decided.data.reason, /outside/i);
});

test('"allow for this task" covers the same class only, and never a delete or a push', async () => {
  const del = (file) => ({ toolCall: { kind: 'delete', title: 'rm', locations: [{ path: file }], rawInput: { path: file } }, options: OPTIONS });
  const push = { toolCall: { kind: 'execute', title: 'push', rawInput: { command: 'git push' } }, options: OPTIONS };
  const r = await run({
    capabilities: [ACTIONS.EDIT, ACTIONS.DELETE, ACTIONS.GIT_PUSH],
    answers: ['approve_all', 'approve_all', 'approve', 'approve_all', 'approve'],
    script: async (h, cwd) => {
      await h.requestPermission(editCall(path.join(cwd, 'a.txt')));   // asks, stands for edits
      await h.requestPermission(editCall(path.join(cwd, 'b.txt')));   // covered, no question
      await h.requestPermission(del(path.join(cwd, 'a.txt')));        // asks
      await h.requestPermission(del(path.join(cwd, 'b.txt')));        // asks again: deletes never stand
      await h.requestPermission(push);                                 // asks
      await h.requestPermission(push);                                 // asks again: pushes never stand
    },
  });
  assert.deepEqual(r.asked.map((a) => a.action),
    [ACTIONS.EDIT, ACTIONS.DELETE, ACTIONS.DELETE, ACTIONS.GIT_PUSH, ACTIONS.GIT_PUSH]);
});

test('a standing allow does not leak into another task', async () => {
  const first = await run({ capabilities: [ACTIONS.EDIT], answers: ['approve_all'],
    script: async (h, cwd) => { await h.requestPermission(editCall(path.join(cwd, 'a.txt'))); } });
  assert.equal(first.asked.length, 1);
  const second = await run({ capabilities: [ACTIONS.EDIT], answers: ['approve'],
    script: async (h, cwd) => { await h.requestPermission(editCall(path.join(cwd, 'a.txt'))); } });
  assert.equal(second.asked.length, 1, 'the next task is asked from scratch');
});

test('reads and thoughts cost nobody an approval', async () => {
  const r = await run({
    script: async (h, cwd) => {
      await h.requestPermission({ toolCall: { kind: 'read', locations: [{ path: path.join(cwd, 'a.txt') }] }, options: OPTIONS });
      await h.requestPermission({ toolCall: { kind: 'search' }, options: OPTIONS });
      h.sessionUpdate({ sessionUpdate: 'agent_thought_chunk', content: { text: 'hmm' } });
    },
  });
  assert.equal(r.asked.length, 0);
});

test('a class the task was never granted is refused, even if the human would have said yes', async () => {
  let picked;
  const r = await run({
    capabilities: [ACTIONS.EDIT],
    answers: ['approve'],
    script: async (h) => { picked = await h.requestPermission({ toolCall: { kind: 'execute', rawInput: { command: 'git push' } }, options: OPTIONS }); },
  });
  assert.equal(r.asked.length, 0);
  assert.deepEqual(picked, { outcome: 'selected', optionId: 'n' });
});

test('the write path is checked again at write time, not only at approval time', async () => {
  const r = await run({
    capabilities: [ACTIONS.EDIT], answers: ['approve'],
    script: async (h, cwd) => {
      await h.requestPermission(editCall(path.join(cwd, 'a.txt')));
      assert.equal(await h.writeTextFile({ path: path.join(cwd, 'a.txt'), content: 'ok' }), null);
      assert.equal(fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8'), 'ok', 'the write actually happened');
      assert.deepEqual(await h.readTextFile({ path: path.join(cwd, 'a.txt') }), { content: 'ok' });
      // Approval was for a path inside; this write is not.
      await assert.rejects(() => h.writeTextFile({ path: '/tmp/elsewhere.txt', content: 'no' }), /Outside/);
      await assert.rejects(() => h.readTextFile({ path: '/etc/passwd' }), /Outside/);
    },
  });
  assert.equal(r.job.status, 'completed');
  assert.ok(events(r).some((e) => e.type === 'tool.completed' && e.data.name === 'write_file'));
});

test('a read is served from the worktree, and a line window is honoured', async () => {
  await run({
    script: async (h, cwd) => {
      fs.writeFileSync(path.join(cwd, 'many.txt'), 'one\ntwo\nthree\nfour');
      assert.deepEqual(await h.readTextFile({ path: path.join(cwd, 'many.txt'), line: 2, limit: 2 }), { content: 'two\nthree' });
      await assert.rejects(() => h.readTextFile({ path: path.join(cwd, 'missing.txt') }), /ENOENT/);
      await assert.rejects(() => h.readTextFile({ path: cwd }), /Not a file/);
    },
  });
});

test('the workspace is released and the egress grant revoked however the task ends', async () => {
  const revoked = [], granted = [];
  const egress = { grant: ({ taskId, domains }) => { granted.push({ taskId, domains }); return { token: 'secret-token' }; },
    revoke: (taskId) => { revoked.push(taskId); return 1; } };
  const ok = await run({ capabilities: [ACTIONS.NETWORK], domains: ['registry.npmjs.org'], egress, script: async () => {} });
  assert.equal(ok.job.status, 'completed');
  assert.equal(granted.length, 1);
  assert.deepEqual(granted[0].domains, ['registry.npmjs.org']);
  assert.deepEqual(revoked, [ok.taskId]);
  assert.equal(ok.workspaces.get(ok.taskId).status, 'released');
  assert.equal(fs.existsSync(ok.workspace), false);

  const boom = await run({ capabilities: [ACTIONS.NETWORK], domains: ['a.test'], egress,
    script: async () => { throw new Error('the harness died'); } });
  assert.equal(boom.job.status, 'failed');
  assert.match(boom.job.error, /the harness died/);
  assert.equal(boom.workspaces.get(boom.taskId).status, 'released', 'a crash still gives the workspace back');
  assert.ok(revoked.includes(boom.taskId));
});

test('no egress grant without both the capability and named domains', async () => {
  const granted = [];
  const egress = { grant: (g) => { granted.push(g); return { token: 't' }; }, revoke: () => 0 };
  await run({ capabilities: [ACTIONS.NETWORK], domains: [], egress, script: async () => {} });
  await run({ capabilities: [ACTIONS.EDIT], domains: ['a.test'], egress, script: async () => {} });
  assert.deepEqual(granted, [], 'a task gets the network only when it was granted one and told where');
});

test('the job records what happened, and the proxy token never reaches the record', async () => {
  const egress = { grant: () => ({ token: 'super-secret-token' }), revoke: () => 1 };
  const r = await run({
    capabilities: [ACTIONS.EDIT, ACTIONS.NETWORK], domains: ['a.test'], egress, answers: ['approve'],
    script: async (h, cwd) => {
      h.sessionUpdate({ sessionUpdate: 'tool_call', toolCallId: '1', kind: 'edit', title: 'Edit a.txt' });
      await h.requestPermission(editCall(path.join(cwd, 'a.txt')));
      h.sessionUpdate({ sessionUpdate: 'tool_call_update', toolCallId: '1', status: 'completed', content: [{ text: 'done' }] });
    },
  });
  const types = events(r).map((e) => e.type);
  for (const wanted of ['job.created', 'job.started', 'tool.started', 'approval.requested', 'approval.decided', 'tool.completed', 'job.completed']) {
    assert.ok(types.includes(wanted), `missing ${wanted}`);
  }
  assert.equal(rawLog(r).includes('super-secret-token'), false, 'the egress token is never written to the job log');
  assert.equal(r.job.result.tools, 1);
  assert.equal(r.job.result.allowed, 1);
});

const rawLog = (r) => fs.readFileSync(path.join(r.dir, 'jobs', r.taskId + '.jsonl'), 'utf8');
const events = (r) => rawLog(r).split('\n').filter(Boolean).map((l) => JSON.parse(l));
