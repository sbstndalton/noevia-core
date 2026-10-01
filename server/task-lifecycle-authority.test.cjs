'use strict';
// #701: lifecycle authority and revisions for Code tasks. `task.stage` / `task.revision` are
// server-only events that only the holder of the lifecycle capability token can append. These
// tests prove the token cannot be forged from an ACP session, an approval payload or a job
// result; that an authoritative journal replays identically after a restart; and that a task
// without those events derives and views byte-for-byte as before. Synthetic data only.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createJobs, derive, claimLifecycleAuthority } = require('./jobs.cjs');
const { view } = require('./code-service.cjs');
const { reportHash, buildCompletenessReport, CHECK_NAMES } = require('./completeness-report.cjs');
const lifecycle = require('./task-lifecycle.cjs');
const fixture = require('./fixtures/code-task-journal.cjs');

// The pipeline's role in this process. Claimed once, here, before anything else can.
const AUTHORITY = claimLifecycleAuthority();

const temps = [];
const temp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); temps.push(d); return d; };
test.after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });

const SHA1 = '1'.repeat(40), SHA2 = '2'.repeat(40), PLAN = 'f'.repeat(64);
const passing = (jobId) => ({ jobId, overall: 'pass', checks: CHECK_NAMES.map((name) => ({ name, status: 'pass', evidence: {}, detail: 'synthetic' })) });
const store = (dir = temp('noevia-lc-')) => ({ dir, jobs: createJobs({ dir, kinds: ['code'], maxJobs: 50 }) });
const codeJob = (jobs) => jobs.create({ kind: 'code', projectId: 'p-synthetic', capabilities: ['read', 'edit'] });
const journal = (dir, id) => fs.readFileSync(path.join(dir, 'jobs', id + '.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const lifecycleKeys = (v) => ['lifecycle', 'revision', 'stages'].filter((k) => Object.prototype.hasOwnProperty.call(v, k));

// --- Flag off: byte-identical ---------------------------------------------------------------

// Generated from origin/main (0fa88a0) before #701, from fixtures/code-task-journal.cjs. Any
// change to how a journal without lifecycle authority derives or views fails here.
const GOLDEN_DERIVED = '{"id":"00000000-0000-4000-8000-000000000701","kind":"code","projectId":"p-synthetic","parentId":null,"capabilities":["read","edit","execute"],"status":"completed","stage":"implementing","steps":[{"id":"harness.config","title":"Pin the harness configuration","status":"completed"}],"artifacts":[],"plan":{"status":"proposed","question":null,"subQuestions":["Find the helper"],"truncated":false},"assistantOutput":{"text":"Done. lifecycle=merged","truncated":false},"checkpoint":{"branch":"noevia/task-synthetic","task":"Rename the widget helper","baseSha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","headSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","identityHash":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","meta":{"harness":"fake"}},"pendingApproval":null,"uncertain":[],"result":{"summary":"ok","lifecycle":"merged","revision":{"n":3,"headSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"stages":[{"stage":"merged"}],"type":"task.stage"},"error":null,"createdAt":1700000000000,"updatedAt":1700000013000,"lifecycle":"verifying","review":{"status":"pending","reviewer":"planner","baseSha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","headSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","files":1}}';
const GOLDEN_VIEW = '{"id":"00000000-0000-4000-8000-000000000701","status":"completed","stage":"implementing","error":null,"task":"Rename the widget helper","branch":"noevia/task-synthetic","baseSha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","headSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","meta":{"harness":"fake"},"identityHash":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","createdAt":1700000000000,"updatedAt":1700000013000,"capabilities":["read","edit","execute"],"steps":[{"id":"harness.config","title":"Pin the harness configuration","status":"completed"}],"plan":{"status":"proposed","question":null,"subQuestions":["Find the helper"],"truncated":false},"assistantOutput":{"text":"Done. lifecycle=merged","truncated":false},"approval":null,"result":{"summary":"ok","lifecycle":"merged","revision":{"n":3,"headSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"stages":[{"stage":"merged"}],"type":"task.stage"},"review":{"status":"pending","reviewer":"planner","baseSha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","headSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","files":1}}';

test('flag off: a journal without lifecycle authority derives and views byte-for-byte as before #701', () => {
  const job = derive(fixture.events);
  assert.equal(JSON.stringify(job), GOLDEN_DERIVED);
  assert.equal(JSON.stringify(view(job)), GOLDEN_VIEW);
  // Every prefix too: a task mid-run is just as unchanged as a finished one.
  for (let k = 1; k <= fixture.events.length; k++) {
    const partial = view(derive(fixture.events.slice(0, k)));
    assert.deepEqual(lifecycleKeys(partial), [], `prefix ${k}`);
    assert.equal(Object.prototype.hasOwnProperty.call(derive(fixture.events.slice(0, k)), 'stages'), false);
  }
});

test('flag off: a real store run with no pipeline never grows lifecycle, revision or stages', async () => {
  const { jobs } = store();
  const id = codeJob(jobs);
  await jobs.run(id, async (ctx) => { ctx.progress('implementing'); ctx.checkpoint({ branch: 'b', headSha: SHA1 }); return { ok: true }; });
  const job = jobs.get(id);
  assert.equal(job.lifecycle, 'verifying', 'the implicit #512 fold is unchanged');
  assert.deepEqual(lifecycleKeys(view(job)), []);
});

// --- The capability token ------------------------------------------------------------------

test('the authority is claimed once per process: a second claim fails', () => {
  assert.throws(() => claimLifecycleAuthority(), /already claimed/);
});

test('append refuses task.stage and task.revision without the exact token', () => {
  const { dir, jobs } = store();
  const id = codeJob(jobs);
  const before = fs.readFileSync(path.join(dir, 'jobs', id + '.jsonl'), 'utf8');
  const lookalikes = [undefined, null, true, 'noevia.task-lifecycle-authority', Symbol('noevia.task-lifecycle-authority'),
    Symbol.for('noevia.task-lifecycle-authority'), { description: 'noevia.task-lifecycle-authority' }, AUTHORITY.toString(), Object(AUTHORITY)];
  for (const token of lookalikes) {
    assert.throws(() => jobs.append(id, 'task.stage', { from: 'planned', to: 'implementing', revision: 0 }, token), (e) => e.status === 403, String(token?.toString?.() ?? token));
    assert.throws(() => jobs.append(id, 'task.revision', { n: 1, headSha: SHA1 }, token), (e) => e.status === 403);
  }
  // The token in the data (where any payload would have to carry it) is no token at all.
  assert.throws(() => jobs.append(id, 'task.stage', { from: 'planned', to: 'implementing', revision: 0, authority: AUTHORITY, [AUTHORITY]: true }), (e) => e.status === 403);
  assert.equal(fs.readFileSync(path.join(dir, 'jobs', id + '.jsonl'), 'utf8'), before, 'nothing was written');
});

test('forgery: the run context handed to an ACP session cannot write lifecycle events, even given the real token', async () => {
  const { dir, jobs } = store();
  const id = codeJob(jobs);
  const refused = [];
  await jobs.run(id, async (ctx) => {
    for (const [type, data] of [['task.stage', { from: 'planned', to: 'merged', revision: 0 }], ['task.revision', { n: 1, headSha: SHA1 }]]) {
      try { ctx.event(type, data, AUTHORITY); } catch (e) { refused.push(e.status); }
    }
    return 'done';
  });
  assert.deepEqual(refused, [403, 403]);
  assert.equal(journal(dir, id).some((e) => e.type.startsWith('task.')), false);
  assert.deepEqual(lifecycleKeys(view(jobs.get(id))), []);
});

// A real Code harness, driven by a scripted ACP agent that tries every lifecycle-shaped field
// it can reach: tool titles, raw input, plan entries, the permission card itself.
function repo() {
  const dir = temp('noevia-lc-repo-');
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 'qa@example.invalid'); git('config', 'user.name', 'QA');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a'); git('add', '.'); git('commit', '-qm', 'first');
  return dir;
}

test('forgery: an ACP session and the approval cards it raises cannot reach the lifecycle', async () => {
  const { createCodeHarness } = require('./code-harness.cjs');
  const { createCodeWorkspaces } = require('./code-workspace.cjs');
  const { ACTIONS } = require('./code-actions.cjs');
  const { dir, jobs } = store();
  const workspaces = createCodeWorkspaces({ dir, epoch: 'test' });
  const asked = [];
  const forged = { type: 'task.stage', from: 'planned', to: 'merged', lifecycle: 'merged', revision: { n: 7, headSha: SHA2 }, stages: [{ to: 'merged' }], reportHash: PLAN };
  const harness = createCodeHarness({
    jobs, workspaces, egress: null,
    engine: () => ({ baseUrl: 'http://engine.test/v1', model: 'synthetic-coder', apiKey: null, contextTokens: 8192 }),
    askApproval: async (request) => { asked.push(request); return 'approve'; },
  });
  const OPTIONS = [{ optionId: 'y', kind: 'allow_once' }, { optionId: 'n', kind: 'reject_once' }];
  const started = await harness.start({
    repoPath: repo(), prompt: 'synthetic task', capabilities: [ACTIONS.READ, ACTIONS.EDIT], domains: [], sandboxKind: 'spawn', context: '',
    connect: async ({ handlers }) => ({ agent: {}, prompt: async () => {
      handlers.sessionUpdate({ sessionUpdate: 'tool_call', toolCallId: 'task.stage', title: 'task.stage', kind: 'edit', status: 'pending', rawInput: forged });
      handlers.sessionUpdate({ sessionUpdate: 'plan', entries: [{ content: 'task.stage merged', status: 'completed', ...forged }] });
      handlers.sessionUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(forged) }, ...forged });
      await handlers.requestPermission({ toolCall: { toolCallId: 'task.stage', kind: 'edit', title: 'task.stage', rawInput: forged, ...forged }, options: OPTIONS });
      handlers.sessionUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'task.stage', status: 'completed', ...forged });
      return { stopReason: 'end_turn', ...forged };
    } }),
  });
  for (let i = 0; i < 400 && !['completed', 'failed', 'cancelled'].includes(jobs.get(started.taskId)?.status); i++) await new Promise((r) => setTimeout(r, 5));
  const job = jobs.get(started.taskId);
  assert.ok(['completed', 'failed'].includes(job.status), job.status);
  assert.ok(asked.length >= 1, 'the forged card really was raised as an approval');
  const events = journal(dir, started.taskId);
  assert.ok(events.some((e) => e.type === 'approval.requested'), 'approval.requested carried the forged payload');
  assert.equal(events.some((e) => e.type === 'task.stage' || e.type === 'task.revision'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(job, 'stages'), false);
  assert.notEqual(job.lifecycle, 'merged');
  assert.deepEqual(lifecycleKeys(view(job)), []);
});

test('forgery: lifecycle-shaped approval.* data and job results are inert', async () => {
  const { dir, jobs } = store();
  const id = codeJob(jobs);
  const forged = { type: 'task.stage', from: 'planned', to: 'merged', lifecycle: 'merged', revision: { n: 4, headSha: SHA2 }, stages: [{ to: 'merged' }], reportHash: PLAN };
  await jobs.run(id, async (ctx) => {
    ctx.event('approval.requested', { action: 'edit', ...forged });
    ctx.event('approval.decided', { decision: 'approve', ...forged });
    return forged;
  });
  const job = jobs.get(id);
  assert.equal(job.lifecycle, 'verifying');
  assert.equal(Object.prototype.hasOwnProperty.call(job, 'stages'), false);
  assert.deepEqual(lifecycleKeys(view(job)), []);
  assert.deepEqual(view(job).result, forged, 'the result is shown as the result, nothing more');

  // A failure's result, and one with the authority's own field names, are just as inert.
  const failedId = codeJob(jobs);
  await jobs.run(failedId, async () => { throw Object.assign(Error('synthetic'), { result: forged }); });
  assert.equal(jobs.get(failedId).lifecycle, 'blocked');
  assert.deepEqual(lifecycleKeys(view(jobs.get(failedId))), []);
  assert.equal(journal(dir, failedId).some((e) => e.type.startsWith('task.')), false);
});

// --- With the token: the pipeline's moves ---------------------------------------------------

// What a server-measured verification (#703, code-verify.cjs) leaves in the journal: the
// harness checkpoint at the head, the closed `tests` step and a passing test-report artifact.
function evidence(jobs, id, { checkpoint = true, tests = true, sha = SHA1 } = {}) {
  if (checkpoint) jobs.append(id, 'checkpoint.created', { branch: 'noevia/task-synthetic', task: 'synthetic', headSha: sha });
  if (tests) {
    jobs.append(id, 'step.started', { id: 'tests', title: 'Run the operator test command' });
    jobs.append(id, 'step.completed', { id: 'tests' });
    jobs.append(id, 'artifact.created', { name: 'test-report', kind: 'test-report', passed: true, exitCode: 0, headSha: sha });
  }
}
const EXPECTED = ['test-report'];

function pipelineToReviewing(jobs, id) {
  jobs.append(id, 'task.stage', { from: 'planned', to: 'planned', revision: 0, reason: 'Planning' }, AUTHORITY);
  jobs.append(id, 'task.stage', { from: 'planned', to: 'implementing', revision: 0, reason: 'Plan accepted' }, AUTHORITY);
  jobs.append(id, 'task.revision', { n: 1, headSha: SHA1, planHash: PLAN }, AUTHORITY);
  jobs.append(id, 'task.stage', { from: 'implementing', to: 'verifying', revision: 1 }, AUTHORITY);
  evidence(jobs, id);
  return jobs.append(id, 'task.stage', { from: 'verifying', to: 'reviewing', revision: 1, reason: 'Tests passed', expectedArtifacts: EXPECTED }, AUTHORITY);
}

test('the pipeline drives planned → implementing → verifying → reviewing, recording the report hash', async () => {
  const { jobs } = store();
  const id = codeJob(jobs);
  let reviewing, expectedHash;
  await jobs.run(id, async () => {
    // Authoritative from the first stage: job.started no longer implies implementing.
    jobs.append(id, 'task.stage', { from: 'planned', to: 'planned', revision: 0 }, AUTHORITY);
    assert.equal(jobs.get(id).lifecycle, 'planned');
    jobs.append(id, 'task.stage', { from: 'planned', to: 'implementing', revision: 0, reason: 'Plan accepted' }, AUTHORITY);
    jobs.append(id, 'task.revision', { n: 1, headSha: SHA1, planHash: PLAN }, AUTHORITY);
    jobs.append(id, 'task.stage', { from: 'implementing', to: 'verifying', revision: 1 }, AUTHORITY);
    evidence(jobs, id);
    expectedHash = reportHash(buildCompletenessReport({ job: jobs.get(id), expectedArtifacts: EXPECTED }));
    reviewing = jobs.append(id, 'task.stage', { from: 'verifying', to: 'reviewing', revision: 1, expectedArtifacts: EXPECTED }, AUTHORITY);
    return { ok: true };
  });
  assert.equal(reviewing.data.reportHash, expectedHash, 'the hash of the report built from the journal');
  assert.equal(Object.prototype.hasOwnProperty.call(reviewing.data, 'report'), false, 'the hash is recorded, not the report');
  const job = jobs.get(id);
  assert.equal(job.status, 'completed');
  assert.equal(job.lifecycle, 'reviewing', 'job.completed does not move an authoritative task');
  const v = view(job);
  assert.equal(v.lifecycle, 'reviewing');
  assert.deepEqual({ ...v.revision, at: 0 }, { n: 1, headSha: SHA1, planHash: PLAN, at: 0 });
  assert.deepEqual(v.stages.map((s) => [s.from, s.to, s.revision]), [
    ['planned', 'planned', 0], ['planned', 'implementing', 0], ['implementing', 'verifying', 1], ['verifying', 'reviewing', 1]]);
  assert.ok(v.stages.every((s) => typeof s.at === 'number'));
});

test('changes requested loops back to implementing at the next revision', () => {
  const { jobs } = store();
  const id = codeJob(jobs);
  pipelineToReviewing(jobs, id);
  jobs.append(id, 'task.stage', { from: 'reviewing', to: 'changes_requested', revision: 1, reason: 'Missing test' }, AUTHORITY);
  jobs.append(id, 'task.stage', { from: 'changes_requested', to: 'implementing', revision: 1 }, AUTHORITY);
  // The old revision is now stale for both kinds of event.
  assert.throws(() => jobs.append(id, 'task.revision', { n: 1, headSha: SHA2 }, AUTHORITY), (e) => e.status === 409);
  jobs.append(id, 'task.revision', { n: 2, headSha: SHA2, planHash: null }, AUTHORITY);
  assert.throws(() => jobs.append(id, 'task.stage', { from: 'implementing', to: 'verifying', revision: 1 }, AUTHORITY), (e) => e.status === 409);
  jobs.append(id, 'task.stage', { from: 'implementing', to: 'verifying', revision: 2 }, AUTHORITY);
  const job = jobs.get(id);
  assert.equal(job.lifecycle, 'verifying');
  assert.equal(job.revision.n, 2);
  assert.equal(job.revision.headSha, SHA2);
});

test('the token proves who writes, not that the move is sound: every unsound move is refused and nothing is written', () => {
  const { dir, jobs } = store();
  const id = codeJob(jobs);
  jobs.append(id, 'task.stage', { from: 'planned', to: 'implementing', revision: 0 }, AUTHORITY);
  const before = fs.readFileSync(path.join(dir, 'jobs', id + '.jsonl'), 'utf8');
  const refuse = (type, data, status, label) => assert.throws(() => jobs.append(id, type, data, AUTHORITY), (e) => e.status === status, label);
  refuse('task.stage', { from: 'planned', to: 'verifying', revision: 0 }, 409, 'stale from');
  refuse('task.stage', { to: 'verifying', revision: 0 }, 409, 'missing from');
  refuse('task.stage', { from: 'implementing', to: 'verifying', revision: 3 }, 409, 'stale revision');
  refuse('task.stage', { from: 'implementing', to: 'verifying' }, 409, 'missing revision');
  refuse('task.stage', { from: 'implementing', to: 'planned', revision: 0 }, 409, 'illegal transition');
  refuse('task.stage', { from: 'implementing', to: 'shipped', revision: 0 }, 400, 'unknown stage');
  refuse('task.stage', { from: 'implementing', to: 'reviewing', revision: 0, expectedArtifacts: EXPECTED }, 409, 'reviewing with no evidence in the journal');
  // A caller-supplied report is ignored: even a "passing" one, or a forged one-check one.
  refuse('task.stage', { from: 'implementing', to: 'reviewing', revision: 0, report: passing(id) }, 409, 'a passing report the caller made up');
  refuse('task.stage', { from: 'implementing', to: 'reviewing', revision: 0, report: { checks: [{ name: 'tests-run', status: 'pass' }] } }, 409, 'forged one-check report, no jobId');
  refuse('task.stage', { from: 'implementing', to: 'merged', revision: 0 }, 409, 'implementing → merged skips review');
  refuse('task.stage', { from: 'implementing', to: 'reviewing', revision: 0, expectedArtifacts: 'test-report' }, 400, 'expectedArtifacts not a list');
  refuse('task.stage', { from: 'implementing', to: 'reviewing', revision: 0, expectedArtifacts: Array(33).fill('a') }, 400, 'too many expected artifacts');
  refuse('task.revision', { n: 2, headSha: SHA1 }, 409, 'skipped revision');
  refuse('task.revision', { n: 1, headSha: 'abc1234' }, 400, 'short sha');
  refuse('task.revision', { n: 1 }, 400, 'no sha');
  refuse('task.revision', { n: 1, headSha: SHA1, planHash: 'not-a-hash' }, 400, 'bad plan hash');
  assert.equal(fs.readFileSync(path.join(dir, 'jobs', id + '.jsonl'), 'utf8'), before);
});

test('reviewing needs the journal itself to be complete: missing tests, checkpoint or artifact each refuse it', () => {
  const cases = [
    [{ tests: false }, EXPECTED, 'tests-run'],
    [{ checkpoint: false }, EXPECTED, 'checkpoint-head-recorded'],
    [{}, null, 'artifacts-present'],
    [{}, ['test-report', 'coverage'], 'artifacts-present'],
  ];
  for (const [opts, expectedArtifacts, failing] of cases) {
    const { jobs } = store();
    const id = codeJob(jobs);
    jobs.append(id, 'task.stage', { from: 'planned', to: 'implementing', revision: 0 }, AUTHORITY);
    jobs.append(id, 'task.revision', { n: 1, headSha: SHA1 }, AUTHORITY);
    jobs.append(id, 'task.stage', { from: 'implementing', to: 'verifying', revision: 1 }, AUTHORITY);
    evidence(jobs, id, opts);
    assert.throws(() => jobs.append(id, 'task.stage', { from: 'verifying', to: 'reviewing', revision: 1, expectedArtifacts, report: passing(id) }, AUTHORITY),
      (e) => e.status === 409 && e.message.includes(failing), failing);
    assert.equal(jobs.get(id).lifecycle, 'verifying');
  }
  // An unresolved uncertainty or a waiting approval blocks it too.
  const { jobs } = store();
  const id = codeJob(jobs);
  jobs.append(id, 'task.stage', { from: 'planned', to: 'implementing', revision: 0 }, AUTHORITY);
  evidence(jobs, id);
  jobs.append(id, 'approval.requested', { action: 'edit' });
  assert.throws(() => jobs.append(id, 'task.stage', { from: 'implementing', to: 'reviewing', revision: 0, expectedArtifacts: EXPECTED }, AUTHORITY), /no-unresolved-uncertainty/);
});

test('merged is reachable only from reviewing', () => {
  for (const path of [['implementing'], ['implementing', 'verifying'], ['implementing', 'blocked', 'implementing']]) {
    const { jobs } = store();
    const id = codeJob(jobs);
    let from = 'planned';
    for (const to of path) { jobs.append(id, 'task.stage', { from, to, revision: 0 }, AUTHORITY); from = to; }
    assert.throws(() => jobs.append(id, 'task.stage', { from, to: 'merged', revision: 0 }, AUTHORITY), (e) => e.status === 409, `${from} → merged`);
  }
  const { jobs } = store();
  const id = codeJob(jobs);
  pipelineToReviewing(jobs, id);
  jobs.append(id, 'task.stage', { from: 'reviewing', to: 'changes_requested', revision: 1 }, AUTHORITY);
  assert.throws(() => jobs.append(id, 'task.stage', { from: 'changes_requested', to: 'merged', revision: 1 }, AUTHORITY), (e) => e.status === 409);
  jobs.append(id, 'task.stage', { from: 'changes_requested', to: 'reviewing', revision: 1, expectedArtifacts: EXPECTED }, AUTHORITY);
  jobs.append(id, 'task.stage', { from: 'reviewing', to: 'merged', revision: 1 }, AUTHORITY);
  assert.equal(jobs.get(id).lifecycle, 'merged');
});

test('lifecycle events are rebuilt from known fields, bounded, and belong to Code jobs only', () => {
  const { dir, jobs } = store();
  const id = codeJob(jobs);
  const e = jobs.append(id, 'task.stage', { from: 'planned', to: 'implementing', revision: 0, reason: `line\nbreak\u0000${'x'.repeat(400)}`, lifecycle: 'merged', stages: ['merged'], extra: 1 }, AUTHORITY);
  assert.deepEqual(Object.keys(e.data).sort(), ['from', 'reason', 'revision', 'to']);
  assert.ok(e.data.reason.length <= 300 && !/[\n\u0000]/.test(e.data.reason));
  const r = jobs.append(id, 'task.revision', { n: 1, headSha: SHA1, planHash: PLAN, lifecycle: 'merged' }, AUTHORITY);
  assert.deepEqual(r.data, { n: 1, headSha: SHA1, planHash: PLAN });

  const research = createJobs({ dir, kinds: ['research'] });
  const other = research.create({ kind: 'research', projectId: 'p-synthetic' });
  assert.throws(() => research.append(other, 'task.stage', { from: 'planned', to: 'implementing', revision: 0 }, AUTHORITY), /Code jobs/);
  // And none on a finished task.
  jobs.append(id, 'job.completed', { result: null });
  assert.throws(() => jobs.append(id, 'task.stage', { from: 'implementing', to: 'verifying', revision: 1 }, AUTHORITY), (err) => err.status === 409);
});

// --- Replay after restart -------------------------------------------------------------------

test('replay after restart: the same journal derives the same lifecycle, revision and stages', () => {
  const { dir, jobs } = store();
  const id = codeJob(jobs);
  pipelineToReviewing(jobs, id);
  const before = jobs.get(id);
  const after = store(dir).jobs.get(id);
  assert.deepEqual(after, before);
  assert.equal(after.lifecycle, 'reviewing');
  // Chunked folding over the journal agrees with the one-pass derive.
  const events = journal(dir, id);
  for (let k = 0; k <= events.length; k++) {
    const head = lifecycle.foldEvents(events.slice(0, k), lifecycle.INITIAL_STATE, { authoritative: true });
    assert.equal(lifecycle.foldEvents(events.slice(k), head, { authoritative: true }), 'reviewing', `split at ${k}`);
  }
  assert.equal(lifecycle.deriveLifecycle(events), 'reviewing');
});

test('replay after restart: an unfinished authoritative task is interrupted into blocked; a merged one stays merged', async () => {
  const { dir, jobs } = store();
  const open = codeJob(jobs);
  pipelineToReviewing(jobs, open);
  const merged = codeJob(jobs);
  let release;
  const running = jobs.run(merged, async () => {
    pipelineToReviewing(jobs, merged);
    jobs.append(merged, 'task.stage', { from: 'reviewing', to: 'merged', revision: 1, reason: 'Accepted' }, AUTHORITY);
    await new Promise((r) => { release = r; });
  });
  while (!release) await new Promise((r) => setTimeout(r, 1));
  // "Restart": a fresh store over the same directory recovers whatever is not running there.
  const restarted = store(dir).jobs;
  assert.equal(restarted.recover(), 2);
  assert.equal(restarted.get(open).lifecycle, 'blocked');
  assert.equal(restarted.get(open).stages.at(-1).to, 'reviewing', 'the record is not rewritten');
  assert.equal(restarted.get(merged).lifecycle, 'merged', 'an interrupt after the merge leaves it merged');
  release(); await running.catch(() => {});
});

test('replay of a tampered journal never throws: an illegal or unproven jump yields a null lifecycle', () => {
  const { dir, jobs } = store();
  const id = codeJob(jobs);
  jobs.append(id, 'task.stage', { from: 'planned', to: 'implementing', revision: 0 }, AUTHORITY);
  const file = path.join(dir, 'jobs', id + '.jsonl');
  const intact = fs.readFileSync(file, 'utf8');
  const line = (seq, data) => JSON.stringify({ job: id, seq, type: 'task.stage', at: 1, data }) + '\n';
  const cases = [
    { from: 'planned', to: 'verifying', revision: 0 }, // stale from
    { from: 'implementing', to: 'planned', revision: 0 }, // illegal
    { from: 'implementing', to: 'reviewing', revision: 0 }, // reviewing with no report hash
    { from: 'implementing', to: 'nowhere', revision: 0 }, // unknown state
    { from: 'implementing', to: 'merged', revision: 0 }, // merged without reviewing
    { from: 'implementing', to: 'verifying', revision: 5 }, // a stage at a revision that never existed
  ];
  const revisionLine = (seq, n) => JSON.stringify({ job: id, seq, type: 'task.revision', at: 1, data: { n, headSha: SHA1, planHash: null } }) + '\n';
  for (const tampered of [revisionLine(3, 2), revisionLine(3, 1) + revisionLine(4, 1), revisionLine(3, 0)]) {
    fs.writeFileSync(file, intact + tampered);
    assert.equal(jobs.get(id).lifecycle, null, 'a revision gap or repeat is tampering');
  }
  for (const data of cases) {
    fs.writeFileSync(file, intact + line(3, data));
    const job = jobs.get(id);
    assert.equal(job.lifecycle, null, JSON.stringify(data));
    assert.ok(Array.isArray(view(job).stages));
    // The pipeline cannot build on an inconsistent journal.
    assert.throws(() => jobs.append(id, 'task.stage', { from: 'implementing', to: 'verifying', revision: 0 }, AUTHORITY), (e) => e.status === 409);
  }
});

test('step(): task.stage folds through transition() and only with authority are implicit moves ignored', () => {
  const ev = (type, data = {}) => ({ type, data });
  assert.equal(lifecycle.step('planned', ev('job.started')), 'implementing');
  assert.equal(lifecycle.step('planned', ev('job.started'), { authoritative: true }), 'planned');
  assert.equal(lifecycle.step('verifying', ev('job.completed'), { authoritative: true }), 'verifying');
  assert.equal(lifecycle.step('verifying', ev('progress', { stage: 'implementing' }), { authoritative: true }), 'verifying');
  assert.equal(lifecycle.step('reviewing', ev('job.failed'), { authoritative: true }), 'blocked');
  assert.equal(lifecycle.step('merged', ev('job.cancelled'), { authoritative: true }), 'merged');
  assert.equal(lifecycle.step('implementing', ev('task.revision', { n: 1 }), { authoritative: true }), 'implementing');
  assert.equal(lifecycle.step('verifying', ev('task.stage', { from: 'verifying', to: 'reviewing', reportHash: PLAN })), 'reviewing');
  assert.throws(() => lifecycle.step('verifying', ev('task.stage', { from: 'verifying', to: 'reviewing' })), lifecycle.TaskLifecycleError);
  assert.throws(() => lifecycle.step('planned', ev('task.stage', { from: 'planned', to: 'merged' })), lifecycle.TaskLifecycleError);
  assert.equal(lifecycle.isAuthoritative(fixture.events), false);
});

test('reportHash is stable across key order and changes with any check', () => {
  const a = passing('x');
  const b = { overall: 'pass', checks: a.checks.map((c) => ({ evidence: {}, detail: c.detail, status: c.status, name: c.name })), jobId: 'x' };
  assert.equal(reportHash(a), reportHash(b));
  assert.match(reportHash(a), /^[0-9a-f]{64}$/);
  const c = passing('x'); c.checks[1].detail = 'other';
  assert.notEqual(reportHash(a), reportHash(c));
  // Hostile input is a 409, never a crash or a hang.
  const circular = passing('x'); circular.checks[0].evidence.self = circular;
  assert.throws(() => reportHash(circular), (e) => e.status === 409 && /circular/.test(e.message));
  let deep = {}; for (let i = 0; i < 200; i++) deep = { deep };
  assert.throws(() => reportHash(deep), (e) => e.status === 409 && /deeply/.test(e.message));
  assert.throws(() => reportHash({ big: 'x'.repeat(5 * 1024 * 1024) }), (e) => e.status === 409 && /large/.test(e.message));
  assert.throws(() => reportHash({ many: Array(300000).fill('abcdefghijklmnop') }), (e) => e.status === 409);
  // A shared (non-circular) sub-object is fine.
  const shared = { k: 1 }; assert.match(reportHash({ a: shared, b: shared }), /^[0-9a-f]{64}$/);
});

// #705: a move into reviewing is judged on the CURRENT round's evidence — the steps and artifacts
// since the task last entered implementing. A failed test run of an earlier revision does not hold
// a later one back, and a passing one does not vouch for it either.
test('reviewing is judged on the current revision: earlier failures do not block, earlier passes do not count', () => {
  const failFirst = () => {
    const { jobs } = store();
    const id = codeJob(jobs);
    jobs.append(id, 'task.stage', { from: 'planned', to: 'implementing', revision: 0 }, AUTHORITY);
    jobs.append(id, 'task.revision', { n: 1, headSha: SHA1, planHash: PLAN }, AUTHORITY);
    jobs.append(id, 'task.stage', { from: 'implementing', to: 'verifying', revision: 1 }, AUTHORITY);
    jobs.append(id, 'checkpoint.created', { branch: 'noevia/task-synthetic', task: 'synthetic', headSha: SHA1 });
    jobs.append(id, 'step.started', { id: 'tests', title: 'Run the tests' });
    jobs.append(id, 'step.completed', { id: 'tests', failed: true });
    jobs.append(id, 'artifact.created', { name: 'test-report', kind: 'test-report', passed: false, headSha: SHA1, revision: 1 });
    assert.throws(() => jobs.append(id, 'task.stage', { from: 'verifying', to: 'reviewing', revision: 1, expectedArtifacts: EXPECTED }, AUTHORITY), /tests-run: fail/);
    jobs.append(id, 'task.stage', { from: 'verifying', to: 'changes_requested', revision: 1, reason: 'Tests failed' }, AUTHORITY);
    jobs.append(id, 'task.stage', { from: 'changes_requested', to: 'implementing', revision: 1 }, AUTHORITY);
    jobs.append(id, 'task.revision', { n: 2, headSha: SHA2, planHash: PLAN }, AUTHORITY);
    jobs.append(id, 'task.stage', { from: 'implementing', to: 'verifying', revision: 2 }, AUTHORITY);
    return { jobs, id };
  };
  // Revision 2 with no test run of its own: refused, although revision 1 recorded one.
  {
    const { jobs, id } = failFirst();
    jobs.append(id, 'checkpoint.created', { branch: 'noevia/task-synthetic', task: 'synthetic', headSha: SHA2 });
    assert.throws(() => jobs.append(id, 'task.stage', { from: 'verifying', to: 'reviewing', revision: 2, expectedArtifacts: EXPECTED }, AUTHORITY), /tests-run: unknown/);
  }
  // Revision 2 with its own passing run: allowed, although revision 1 failed.
  {
    const { jobs, id } = failFirst();
    evidence(jobs, id, { sha: SHA2 });
    const e = jobs.append(id, 'task.stage', { from: 'verifying', to: 'reviewing', revision: 2, expectedArtifacts: EXPECTED }, AUTHORITY);
    assert.match(e.data.reportHash, /^[0-9a-f]{64}$/);
    // The view keeps both runs, each closed by its own completion.
    assert.deepEqual(jobs.get(id).steps.filter((s) => s.id === 'tests').map((s) => s.status), ['failed', 'completed']);
  }
});

test('flag off: a non-pipeline journal with a repeated step id derives exactly as before (#705 review)', () => {
  const { jobs } = store();
  const id = codeJob(jobs);
  jobs.append(id, 'step.started', { id: 'harness.config', title: 'Pin' });
  jobs.append(id, 'step.started', { id: 'harness.config', title: 'Pin again' });
  jobs.append(id, 'step.completed', { id: 'harness.config' });
  jobs.append(id, 'step.completed', { id: 'harness.config', failed: true });
  // The original rule: every completion closes the FIRST step with that id.
  assert.deepEqual(jobs.get(id).steps.map((s) => s.status), ['failed', 'running']);
  assert.equal('stages' in jobs.get(id), false);
});
