'use strict';
// code-service.cjs with the Code pipeline (#705): the "Planner" preparation exists only with the
// flag on AND the sandbox, starts the pipeline through the service, and with the flag off every
// list, start and view is exactly what it was. Synthetic repositories, fake transport and roles.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createCodeService, PROMPT_PREPARATION, PLANNER_PREPARATION } = require('./code-service.cjs');
const { createCodePipeline } = require('./code-pipeline.cjs');
const { createVerifyAdapter } = require('./code-pipeline-verify.cjs');
const { REVIEW_ACTION } = require('./code-review.cjs');

const temps = [];
const temp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); temps.push(d); return d; };
test.after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function repo() {
  const dir = temp('noevia-psrepo-');
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'config', 'user.email', 'qa@example.invalid'); git(dir, 'config', 'user.name', 'QA');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a'); git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'first');
  return dir;
}
const project = { id: 'p1' };
const PLAN = { goal: 'Change a.', context: [], constraints: [], investigation: [], steps: [{ n: 1, do: 'Edit a.txt', done_when: 'a.txt says b' }],
  capabilities: ['edit'], approval_boundaries: [], verification: [], completion: 'done', non_goals: [] };

function measuredVerifier() {
  const measured = new WeakSet();
  return { available: () => true,
    isMeasured: (r, e) => measured.has(r) && r.taskId === e.taskId && r.headSha === e.headSha && r.revision === e.revision,
    run: async ({ taskId, headSha, revision, emit }) => {
      const report = Object.freeze({ kind: 'test-report', passed: true, exitCode: 0, tail: 'ok', taskId, headSha, revision });
      measured.add(report);
      emit('step.started', { id: 'tests', title: 'Run the tests' });
      emit('artifact.created', { ...report });
      emit('step.completed', { id: 'tests' });
      return { status: 'passed', report, error: null };
    } };
}

function service({ flag = false, sandboxKind = 'sandbox', withPipeline = true } = {}) {
  const ws = { dir: temp('noevia-psws-'), userId: 'tenant-synthetic' };
  const repoPath = repo();
  const created = [];
  const svc = createCodeService({ repos: [{ id: 'fixture', path: repoPath }], sandboxKind, timeoutMs: 2000,
    engine: () => ({ baseUrl: 'http://engine.test/v1', model: 'synthetic-coder' }),
    connect: async ({ cwd }) => ({ agent: {}, prompt: async () => {
      fs.writeFileSync(path.join(cwd, 'a.txt'), 'b'); git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'edit');
      return { stopReason: 'end_turn' };
    } }),
    ...(withPipeline ? { pipeline: { enabled: () => flag, create: (deps) => {
      created.push(Object.keys(deps).sort());
      return createCodePipeline({ ...deps, merge: () => false,
        roleEngine: { pinModel: async ({ taskId }) => ({ ok: true, session: { taskId, model: 'synthetic-coder', call: async () => ({ ok: false, code: 'error' }) } }) },
        planner: { generate: async () => ({ ok: true, plan: PLAN }) },
        review: { review: async () => ({ ok: true, corrected: false, verdict: { verdict: 'approve', summary: 'Fine.', findings: [] } }) },
        verify: createVerifyAdapter(measuredVerifier()) });
    } } } : {}) });
  return { svc, ws, repoPath, created };
}
const settle = async (svc, ws, id, until = ['completed', 'failed', 'cancelled']) => {
  for (let i = 0; i < 400 && !until.includes(svc.get(ws, project, id)?.status); i++) await new Promise((r) => setTimeout(r, 5));
  return svc.get(ws, project, id);
};

test('flag off: the preparations offered are exactly the ones before the pipeline, and "planner" is unknown', async () => {
  for (const setup of [{ flag: false }, { flag: true, sandboxKind: 'spawn' }, { withPipeline: false }]) {
    const { svc, ws } = service(setup);
    assert.equal(JSON.stringify(svc.promptPreparation()), JSON.stringify(PROMPT_PREPARATION), JSON.stringify(setup));
    await assert.rejects(() => svc.start(ws, project, { repository: 'fixture', prompt: 'x', promptPreparation: 'planner' }),
      (e) => e.status === 400 && e.message === 'Unknown prompt preparation.', JSON.stringify(setup));
  }
});

test('flag off: a direct task runs and views byte-for-byte as before (no lifecycle, no pipeline fields)', async () => {
  const off = service({ flag: false });
  const started = await off.svc.start(off.ws, project, { repository: 'fixture', prompt: 'edit a' });
  const done = await settle(off.svc, off.ws, started.taskId);
  assert.equal(done.status, 'completed');
  for (const key of ['lifecycle', 'revision', 'stages', 'pipeline']) assert.equal(key in done, false, key);
  assert.deepEqual(Object.keys(done), ['id', 'status', 'stage', 'error', 'task', 'branch', 'baseSha', 'headSha', 'meta', 'identityHash',
    'createdAt', 'updatedAt', 'capabilities', 'steps', 'plan', 'assistantOutput', 'approval', 'result']);
  // The same task with no pipeline wired at all has the same shape.
  const none = service({ withPipeline: false });
  const s2 = await none.svc.start(none.ws, project, { repository: 'fixture', prompt: 'edit a' });
  const d2 = await settle(none.svc, none.ws, s2.taskId);
  assert.deepEqual(Object.keys(d2), Object.keys(done));
});

test('flag on with the sandbox: "Planner" is offered and runs the pipeline; the person answers the accept card', async () => {
  const { svc, ws, created } = service({ flag: true });
  assert.deepEqual(svc.promptPreparation().map((p) => p.id), [...PROMPT_PREPARATION.map((p) => p.id), 'planner']);
  assert.deepEqual(svc.promptPreparation().at(-1), { ...PLANNER_PREPARATION });
  const started = await svc.start(ws, project, { repository: 'fixture', prompt: 'Change a to b.', promptPreparation: 'planner' });
  assert.equal(started.promptPreparation, 'planner');
  assert.match(started.branch, /^noevia\/task-/);
  assert.deepEqual(created[0], ['askApproval', 'harness', 'jobs', 'workspaces']);
  const waiting = await settle(svc, ws, started.taskId, ['waiting_approval', 'failed', 'completed']);
  assert.equal(waiting.status, 'waiting_approval', waiting.error);
  assert.equal(waiting.approval.action, REVIEW_ACTION);
  assert.equal(waiting.lifecycle, 'reviewing');
  assert.equal(waiting.revision.n, 1);
  assert.equal(waiting.pipeline.evidence[0].tests.passed, true);
  assert.equal(waiting.pipeline.audit.overall, 'complete');
  assert.equal(waiting.approval.verdict.verdict, 'approve');
  // Only the three write-approval answers are accepted, for the card the person saw.
  assert.throws(() => svc.decide(ws, project, started.taskId, 'merge', waiting.approval.id), (e) => e.status === 400);
  svc.decide(ws, project, started.taskId, 'approve', waiting.approval.id);
  const done = await settle(svc, ws, started.taskId);
  assert.equal(done.status, 'completed');
  assert.deepEqual({ accepted: done.result.accepted, merged: done.result.merged }, { accepted: true, merged: false });
  // One task at a time still holds for pipeline tasks.
});

test('cancelling a pipeline task through the service refuses its open card and blocks it', async () => {
  const { svc, ws } = service({ flag: true });
  const started = await svc.start(ws, project, { repository: 'fixture', prompt: 'Change a to b.', promptPreparation: 'planner' });
  const waiting = await settle(svc, ws, started.taskId, ['waiting_approval', 'failed', 'completed']);
  assert.equal(waiting.status, 'waiting_approval');
  await assert.rejects(() => svc.start(ws, project, { repository: 'fixture', prompt: 'again', promptPreparation: 'planner' }), /already has a task running/);
  svc.cancel(ws, project, started.taskId);
  const done = await settle(svc, ws, started.taskId);
  assert.equal(done.status, 'cancelled');
  assert.equal(done.lifecycle, 'blocked');
  assert.equal(done.approval, null);
});
