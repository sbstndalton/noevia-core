// The Code pipeline (#705): every branch of Planner → Executor → verify → review → Auditor, run for
// real against a git fixture, the real job store, workspaces and harness, with a scripted agent and
// fake model roles. Synthetic data only; no model, no network.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createJobs } = require('./jobs.cjs');
const { createCodeWorkspaces } = require('./code-workspace.cjs');
const { createCodeHarness } = require('./code-harness.cjs');
const { createCodePipeline, renderExecutorBrief, EXECUTOR_INSTRUCTIONS, PIPELINE_META, PLAN_ACTION } = require('./code-pipeline.cjs');
const { createVerifyAdapter } = require('./code-pipeline-verify.cjs');
const { INSTRUCTIONS: PLANNER_INSTRUCTIONS } = require('./planner-plan.cjs');
const { INSTRUCTIONS: REVIEW_INSTRUCTIONS, REVIEW_ACTION } = require('./code-review.cjs');
const { AUDIT_INSTRUCTIONS, pipelineView } = require('./auditor-report.cjs');
const { SHARED_FRAME } = require('./role-engine.cjs');
const { view } = require('./code-service.cjs');

const temps = [];
const temp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); temps.push(d); return d; };
test.after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function repo() {
  const dir = temp('noevia-prepo-');
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'config', 'user.email', 'qa@example.invalid'); git(dir, 'config', 'user.name', 'QA');
  fs.writeFileSync(path.join(dir, 'README.md'), '# Widget\nA synthetic fixture repository.\n');
  fs.writeFileSync(path.join(dir, 'widget.js'), 'module.exports = () => 1;\n');
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'first');
  return dir;
}

const PLAN = Object.freeze({
  goal: 'Make the widget return two.', context: [], constraints: ['Keep the export shape.'], investigation: [],
  steps: [{ n: 1, do: 'Change widget.js to return two', done_when: 'widget() === 2' }, { n: 2, do: 'Add a test', done_when: 'the test passes' }],
  capabilities: ['edit'], approval_boundaries: [], verification: ['Run the tests'], completion: 'widget returns two', non_goals: [],
});

// The #703 contract, faithfully: reports are frozen and remembered; only those count as measured.
function fakeVerifier(outcomes) {
  const measured = new WeakSet();
  const calls = [];
  return {
    calls,
    available: () => true,
    isMeasured: (report, e) => !!report && measured.has(report) && report.taskId === e.taskId && report.headSha === e.headSha && report.revision === e.revision,
    async run({ taskId, headSha, revision, emit, signal, workspaces }) {
      calls.push({ taskId, headSha, revision });
      emit('step.started', { id: 'tests', title: 'Run the tests' });
      const next = typeof outcomes === 'function' ? await outcomes({ revision, signal, workspaces, taskId }) : outcomes.shift();
      if (next === 'unavailable') { emit('step.completed', { id: 'tests', failed: true }); return { status: 'unavailable', report: null, error: { code: 'no_verifier', message: 'no verifier' } }; }
      if (next === 'unmeasured') { emit('step.completed', { id: 'tests' }); return { status: 'passed', report: { kind: 'test-report', passed: true, taskId, headSha, revision }, error: null }; }
      const passed = next === 'pass';
      const report = Object.freeze({ kind: 'test-report', passed, exitCode: passed ? 0 : 1, signal: null, timedOut: false,
        tail: passed ? 'ok 1 widget\n' : 'not ok 1 widget returns two\n', tailBytes: 10, totalBytes: 10, truncated: false,
        taskId, headSha, revision, repo: 'fixture', durationMs: 5, measuredBy: 'verifier' });
      measured.add(report);
      emit('artifact.created', { ...report });
      emit('step.completed', { id: 'tests', failed: !passed });
      return { status: passed ? 'passed' : 'failed', report, error: null };
    },
  };
}

/**
 * Run one pipeline task to its end. `verdicts` are the Planner's review answers in order (or a
 * function); `answers` maps a card action to the person's answer.
 */
async function runPipeline({ verdicts = ['approve'], tests = ['pass'], merge = true, answers = {}, approvePlan = false,
  plan = PLAN, verify = null, agent = null, onReview = null, onAccept = null, deadlines = {}, maxLoops = 2,
  auditText = JSON.stringify({ completeness: 'complete', summary: 'All plan steps have evidence.', evidence: [{ source: 'tests', note: 'Measured at head.' }], gaps: [] }),
  cancelDuring = null, detach = true, wrapJobs = (j) => j, pin = null } = {}) {
  const dir = temp('noevia-pjobs-');
  const source = repo();
  const jobs = createJobs({ dir });
  const workspaces = createCodeWorkspaces({ dir, epoch: 'test' });
  const asked = [];
  const askApproval = async (request) => {
    asked.push(request);
    if (request.action === REVIEW_ACTION && onAccept) await onAccept({ source, request });
    const a = answers[request.action];
    return typeof a === 'function' ? a(request) : a ?? 'approve';
  };
  const harness = createCodeHarness({ jobs, workspaces, askApproval,
    engine: () => ({ baseUrl: 'http://engine.test/v1', model: 'synthetic-coder', apiKey: null, contextTokens: 8192 }) });
  const sent = [], reviewStates = [], plannerStates = [], auditCalls = [];
  let round = 0;
  const session = {
    taskId: null, model: 'synthetic-coder', thinking: false,
    async call(args) { auditCalls.push(args); return { ok: true, text: auditText, corrected: false }; },
  };
  const control = { cancel: () => jobs.cancel(started.taskId) };
  const verifier = verify || fakeVerifier(Array.isArray(tests) ? [...tests] : (args) => tests({ ...args, control }));
  const pipeline = createCodePipeline({
    jobs: wrapJobs(jobs), workspaces, harness, askApproval, deadlines, maxLoops,
    roleEngine: { pinModel: async (args) => {
      if (pin) return pin({ ...args, control });
      session.taskId = args.taskId; return { ok: true, session };
    } },
    planner: { generate: async ({ state }) => { plannerStates.push(state); return { ok: true, plan }; } },
    review: { review: async ({ state, signal }) => {
      reviewStates.push(state);
      if (onReview) await onReview({ state, source, signal, control });
      const v = typeof verdicts === 'function' ? verdicts(state) : verdicts.shift() ?? 'approve';
      if (v && typeof v === 'object') return v;
      return { ok: true, corrected: false, verdict: v === 'approve'
        ? { verdict: 'approve', summary: 'Looks right.', findings: [] }
        : { verdict: 'request_changes', summary: 'Needs a test.', findings: [{ severity: 'major', file: 'widget.js', message: `Add a test (round ${state.revision}).` }] } };
    } },
    verify: createVerifyAdapter(verifier),
    merge: typeof merge === 'function' ? merge : () => merge,
  });
  const connect = async ({ cwd, signal }) => ({ agent: {}, prompt: async (text) => {
    sent.push(text); round += 1;
    if (cancelDuring === 'implement') control.cancel();
    if (agent) return agent({ cwd, signal, round, text });
    fs.writeFileSync(path.join(cwd, 'widget.js'), `module.exports = () => 2; // round ${round}\n`);
    git(cwd, 'add', 'widget.js'); git(cwd, 'commit', '-qm', `round ${round}`);
    return { stopReason: 'end_turn' };
  } });
  const started = pipeline.start({ projectId: 'p-synthetic', repo: { id: 'fixture', path: source }, prompt: 'Make the widget return two.',
    capabilities: ['read', 'edit', 'execute'], connect, tenantId: 'tenant-synthetic', approvePlan });
  // noevia never moves a base that is checked out (#715 review): the owner's tree is on no branch.
  if (detach) git(source, 'checkout', '-q', '--detach');
  for (let i = 0; i < 600 && !['completed', 'failed', 'cancelled'].includes(jobs.get(started.taskId)?.status); i++) await new Promise((r) => setTimeout(r, 5));
  const job = jobs.get(started.taskId);
  return { ...started, dir, source, jobs, workspaces, job, view: view(job), asked, sent, reviewStates, plannerStates, auditCalls, verifier,
    stagePath: job.stages.map((s) => s.to), main: git(source, 'rev-parse', 'main') };
}

test('pass, merge on: planned → implementing → verifying → reviewing → merged, base fast-forwarded to the reviewed head', async () => {
  const r = await runPipeline();
  assert.equal(r.job.status, 'completed', r.job.error);
  assert.deepEqual(r.stagePath, ['planned', 'implementing', 'verifying', 'reviewing', 'merged']);
  assert.equal(r.job.lifecycle, 'merged');
  assert.equal(r.job.revision.n, 1);
  const head = r.job.revision.headSha;
  assert.equal(r.main, head, 'main now points at the exact reviewed commit');
  assert.deepEqual({ accepted: r.job.result.accepted, merged: r.job.result.merged, mergedInto: r.job.result.mergedInto }, { accepted: true, merged: true, mergedInto: 'main' });
  // The reviewing stage carries the hash of the completeness report jobs.cjs built.
  assert.match(r.job.stages.find((s) => s.to === 'reviewing').reportHash, /^[0-9a-f]{64}$/);
  // The accept card: verdict, audit, evidence and the merge it will do.
  const card = r.asked.find((a) => a.action === REVIEW_ACTION);
  assert.equal(card.verdict.verdict, 'approve');
  assert.equal(card.audit.overall, 'complete', JSON.stringify(card.audit));
  assert.equal(card.audit.writeUp.completeness, 'complete');
  assert.deepEqual(card.merge, { into: 'main', from: r.job.checkpoint.baseSha, to: head });
  assert.equal(card.evidence.tests.passed, true);
  assert.equal(card.arguments.headSha, head);
  // The review saw this revision's head and the measured tests.
  assert.equal(r.reviewStates[0].revision, 1);
  assert.equal(r.reviewStates[0].execution.headSha, head);
  assert.equal(r.reviewStates[0].change.headSha, head);
  // The Planner got the repository snapshot as project snippets: file list and README.
  const snippets = r.plannerStates[0].snippets;
  assert.ok(snippets.some((s) => s.label === 'git ls-files' && s.text.includes('widget.js')));
  assert.ok(snippets.some((s) => s.label === 'README.md' && s.text.includes('synthetic fixture')));
  // The Auditor write-up was asked with the audit schema, as the auditor role.
  assert.equal(r.auditCalls[0].role, 'auditor');
  assert.deepEqual(r.auditCalls[0].schema.required, ['completeness', 'summary', 'evidence', 'gaps']);
  // The view #706 reads.
  assert.equal(r.view.lifecycle, 'merged');
  assert.equal(r.view.pipeline.evidence.length, 1);
  assert.equal(r.view.pipeline.evidence[0].headSha, head);
  assert.equal(r.view.pipeline.evidence[0].tests.passed, true);
  assert.equal(r.view.pipeline.evidence[0].review.verdict, 'approve');
  assert.match(r.view.pipeline.evidence[0].completeness.reportHash, /^[0-9a-f]{64}$/);
  assert.equal(r.view.pipeline.audit.overall, 'complete');
  assert.equal(r.view.pipeline.plan.plan.goal, PLAN.goal);
  assert.equal(r.view.pipeline.maxLoops, 2);
});

test('request changes loops once: revision 2 gets the findings, is verified and reviewed again', async () => {
  const r = await runPipeline({ verdicts: ['request_changes', 'approve'], tests: ['pass', 'pass'], merge: false });
  assert.equal(r.job.status, 'completed', r.job.error);
  assert.deepEqual(r.stagePath, ['planned', 'implementing', 'verifying', 'reviewing', 'changes_requested', 'implementing', 'verifying', 'reviewing']);
  assert.equal(r.job.revision.n, 2);
  assert.equal(r.sent.length, 2);
  assert.match(r.sent[1], /Fix from the last round:\n- major in widget\.js: Add a test \(round 1\)\./);
  assert.doesNotMatch(r.sent[0], /Fix from the last round/);
  assert.deepEqual(r.verifier.calls.map((c) => c.revision), [1, 2]);
  assert.deepEqual(r.view.pipeline.evidence.map((e) => [e.revision, e.review.verdict]), [[1, 'request_changes'], [2, 'approve']]);
  assert.notEqual(r.view.pipeline.evidence[0].headSha, r.view.pipeline.evidence[1].headSha);
  // Both rounds are on the same branch, the second building on the first.
  const branch = r.job.checkpoint.branch;
  assert.equal(git(r.source, 'rev-list', '--count', `main..${branch}`), '2');
  assert.equal(r.job.checkpoint.baseSha, r.main, 'the base recorded at the first claim is kept');
});

test('failing tests go to changes_requested and loop; the next revision passes', async () => {
  const r = await runPipeline({ tests: ['fail', 'pass'], verdicts: ['approve'], merge: false });
  assert.equal(r.job.status, 'completed', r.job.error);
  assert.deepEqual(r.stagePath, ['planned', 'implementing', 'verifying', 'changes_requested', 'implementing', 'verifying', 'reviewing']);
  assert.equal(r.reviewStates.length, 1, 'a failed revision is never sent for review');
  assert.match(r.sent[1], /The operator's tests failed at revision 1 \(exit 1\)\./);
  assert.match(r.sent[1], /not ok 1 widget returns two/);
  assert.equal(r.view.pipeline.evidence[0].tests.passed, false);
  assert.equal(r.view.pipeline.evidence[1].tests.passed, true);
  // jobs.cjs judged revision 2 on its own evidence: the failed tests step of revision 1 did not block it.
  assert.equal(r.job.steps.filter((s) => s.id === 'tests').map((s) => s.status).join(), 'failed,completed');
});

test('more than two change loops: blocked, with three revisions and no accept card', async () => {
  const r = await runPipeline({ verdicts: () => 'request_changes', tests: () => 'pass' });
  assert.equal(r.job.status, 'failed');
  assert.equal(r.job.lifecycle, 'blocked');
  assert.match(r.job.error, /after 2 rounds of changes/);
  assert.equal(r.job.revision.n, 3);
  assert.equal(r.sent.length, 3);
  assert.equal(r.stagePath.at(-1), 'blocked');
  assert.equal(r.stagePath.at(-2), 'changes_requested');
  assert.equal(r.asked.some((a) => a.action === REVIEW_ACTION), false);
  assert.equal(r.main, git(r.source, 'rev-parse', 'main~0'), 'nothing merged');
  assert.equal(r.job.result.blocked, true);
  assert.equal(r.job.result.loops, 3);
});

test('verification unavailable blocks at verifying; it is never treated as a pass', async () => {
  const r = await runPipeline({ tests: ['unavailable'] });
  assert.equal(r.job.status, 'failed');
  assert.deepEqual(r.stagePath, ['planned', 'implementing', 'verifying', 'blocked']);
  assert.match(r.job.error, /Verification is unavailable/);
  assert.equal(r.reviewStates.length, 0);
  // No verifier configured at all (the server default until #703 is wired): the same.
  const none = await runPipeline({ verify: { available: () => false } });
  assert.deepEqual(none.stagePath, ['planned', 'implementing', 'verifying', 'blocked']);
  assert.match(none.job.error, /Verification is not available/);
  const adapterOnly = createVerifyAdapter(null);
  assert.equal(adapterOnly.available(), false);
  assert.equal((await adapterOnly.run({})).status, 'unavailable');
});

test('a "passed" the verifier did not measure for this task, head and revision blocks', async () => {
  const r = await runPipeline({ tests: ['unmeasured'] });
  assert.equal(r.job.status, 'failed');
  assert.deepEqual(r.stagePath, ['planned', 'implementing', 'verifying', 'blocked']);
  assert.match(r.job.error, /not measured by the verifier/);
});

test('cancel mid-stage: the agent is stopped, the job is cancelled, the lifecycle blocked and the workspace given back', async () => {
  const r = await runPipeline({ cancelDuring: 'implement', agent: ({ signal }) => new Promise((resolve, reject) => {
    if (signal.aborted) return reject(Error('aborted'));
    signal.addEventListener('abort', () => reject(Error('aborted')), { once: true });
  }) });
  assert.equal(r.job.status, 'cancelled');
  assert.equal(r.job.lifecycle, 'blocked');
  assert.equal(r.stagePath.at(-1), 'blocked');
  assert.equal(r.workspaces.get(r.taskId).status, 'released');
  assert.equal(r.verifier.calls.length, 0);
});

test('cancel during verification and during review propagates into that stage', async () => {
  let verifySignal = null;
  const v = await runPipeline({ tests: async ({ signal, control }) => {
    control.cancel();
    verifySignal = signal;
    return 'pass';
  } });
  assert.equal(verifySignal.aborted, true, 'the verifier’s signal is aborted by the cancel');
  assert.equal(v.job.status, 'cancelled');
  assert.equal(v.job.lifecycle, 'blocked');
  assert.equal(v.reviewStates.length, 0);

  let reviewSignal = null;
  const r = await runPipeline({ onReview: async ({ signal, control }) => { control.cancel(); reviewSignal = signal; } });
  assert.equal(reviewSignal.aborted, true, 'the review’s signal is aborted by the cancel');
  assert.equal(r.job.status, 'cancelled');
  assert.equal(r.job.lifecycle, 'blocked');
  assert.equal(r.asked.some((a) => a.action === REVIEW_ACTION), false);
});

test('the stale revision is rejected: a verdict for a head the branch has moved past is not used', async () => {
  const r = await runPipeline({ onReview: async ({ state, source }) => {
    // Someone moves the task branch in the source while the Planner reviews the old head.
    const branch = execFileSync('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads/noevia/'], { cwd: source, encoding: 'utf8' }).trim();
    const tmp = temp('noevia-stale-');
    git(source, 'worktree', 'add', '-q', tmp, branch);
    fs.writeFileSync(path.join(tmp, 'late.txt'), 'late');
    git(tmp, 'add', '.'); git(tmp, 'commit', '-qm', 'late');
    git(source, 'worktree', 'remove', '--force', tmp);
    assert.equal(state.revision, 1);
  } });
  assert.equal(r.job.status, 'failed');
  assert.match(r.job.error, /earlier revision/);
  assert.equal(r.stagePath.at(-1), 'blocked');
  assert.equal(r.job.review.status, 'failed');
  assert.equal(r.asked.some((a) => a.action === REVIEW_ACTION), false, 'no accept card for a stale verdict');
});

test('every stage event carries the revision current when it was written, and nobody without the token can add one', async () => {
  const r = await runPipeline({ merge: false });
  // The pipeline's own events: each task.stage carries the revision current when it was written.
  assert.deepEqual(r.job.stages.map((s) => s.revision), [0, 0, 1, 1]);
  // And a job that has ended takes no more lifecycle events, from anyone.
  assert.throws(() => r.jobs.append(r.taskId, 'task.stage', { from: 'reviewing', to: 'merged', revision: 1 }), (e) => e.status === 403);
});

test('a moved base refuses the merge: accepted, not merged, blocked, and the base keeps its new commit', async () => {
  let moved = null;
  const r = await runPipeline({ onAccept: async ({ source }) => {
    const tmp = temp('noevia-other-');
    fs.rmSync(tmp, { recursive: true, force: true });
    git(source, 'worktree', 'add', '-q', tmp, 'main');
    fs.writeFileSync(path.join(tmp, 'other.txt'), 'someone else');
    git(tmp, 'add', '.'); git(tmp, 'commit', '-qm', 'someone else');
    git(source, 'worktree', 'remove', '--force', tmp);
    moved = git(source, 'rev-parse', 'main');
  } });
  assert.equal(r.job.status, 'failed');
  assert.match(r.job.error, /Accepted, but not merged: main has moved/);
  assert.equal(r.main, moved, 'main is exactly where the other commit left it');
  assert.equal(r.job.lifecycle, 'blocked');
  assert.deepEqual(r.stagePath.slice(-2), ['reviewing', 'blocked']);
  assert.equal(r.job.result.mergeRefused, 'base_moved');
});

test('codeMerge off: accepting records the reviewed head as accepted and merges nothing', async () => {
  const r = await runPipeline({ merge: false });
  const before = r.job.checkpoint.baseSha;
  assert.equal(r.job.status, 'completed');
  assert.equal(r.job.lifecycle, 'reviewing');
  assert.deepEqual({ accepted: r.job.result.accepted, merged: r.job.result.merged }, { accepted: true, merged: false });
  assert.equal(r.main, before, 'main did not move');
  const card = r.asked.find((a) => a.action === REVIEW_ACTION);
  assert.equal(card.merge, null);
  assert.match(card.reason, /nothing is merged/);
});

test('a declined accept card merges nothing, whatever codeMerge says', async () => {
  for (const answer of ['deny', 'timeout', 'aborted']) {
    const r = await runPipeline({ answers: { [REVIEW_ACTION]: answer } });
    assert.equal(r.job.status, 'completed');
    assert.equal(r.job.result.accepted, false, answer);
    assert.equal(r.job.result.merged, false);
    assert.equal(r.main, r.job.checkpoint.baseSha);
    assert.equal(r.job.lifecycle, 'reviewing');
  }
  const all = await runPipeline({ answers: { [REVIEW_ACTION]: 'approve_all' } });
  assert.equal(all.job.result.merged, true, 'approve_all is a yes for this one card');
});

test('the optional plan card: approved runs on; declined blocks before the agent is ever started', async () => {
  const yes = await runPipeline({ approvePlan: true });
  assert.equal(yes.asked[0].action, PLAN_ACTION);
  assert.equal(yes.asked[0].arguments.goal, PLAN.goal);
  assert.equal(yes.job.status, 'completed');
  const no = await runPipeline({ approvePlan: true, answers: { [PLAN_ACTION]: 'deny' } });
  assert.equal(no.job.status, 'failed');
  assert.match(no.job.error, /plan was not approved/);
  assert.deepEqual(no.stagePath, ['planned', 'blocked']);
  assert.equal(no.sent.length, 0);
});

test('a stage deadline blocks the task with the stage that ran out', async () => {
  const r = await runPipeline({ deadlines: { implement: 40 }, agent: ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(Error('stopped')), { once: true });
  }) });
  assert.equal(r.job.status, 'failed');
  assert.match(r.job.error, /The implement stage did not finish within 1 minute\.$/);
  assert.deepEqual(r.stagePath, ['planned', 'implementing', 'blocked']);
  assert.equal(r.workspaces.get(r.taskId).status, 'released');
});

test('an agent that changes nothing blocks instead of reviewing an empty change', async () => {
  const r = await runPipeline({ agent: () => ({ stopReason: 'end_turn' }) });
  assert.equal(r.job.status, 'failed');
  assert.match(r.job.error, /made no change/);
  assert.deepEqual(r.stagePath, ['planned', 'implementing', 'blocked']);
});

test('a failed review or audit write-up: review blocks; a write-up failure leaves the deterministic audit', async () => {
  const r = await runPipeline({ verdicts: [{ ok: false, code: 'timeout', reason: 'The review did not finish within 180 seconds.' }] });
  assert.equal(r.job.status, 'failed');
  assert.match(r.job.error, /review did not finish/);
  const w = await runPipeline({ auditText: '{"completeness":"complete","summary":"x","evidence":[],"gaps":[],"verdict":"approve"}', merge: false });
  assert.equal(w.job.status, 'completed');
  assert.equal(w.view.pipeline.audit.writeUp, null, 'a write-up with fields an audit cannot have is dropped');
  assert.equal(w.view.pipeline.audit.overall, 'complete');
});

// ── isolation ───────────────────────────────────────────────────────────────────────────────────

const lines = (text) => text.split('\n').map((l) => l.trim()).filter((l) => l.length > 20);

test('isolation: the Executor prompt carries no pipeline, Planner, reviewer or Auditor instructions', async () => {
  const r = await runPipeline({ verdicts: ['request_changes', 'approve'], tests: ['pass', 'pass'], merge: false });
  assert.equal(r.sent.length, 2);
  for (const prompt of r.sent) {
    for (const forbidden of [PLANNER_INSTRUCTIONS, REVIEW_INSTRUCTIONS, AUDIT_INSTRUCTIONS, SHARED_FRAME, PIPELINE_META]) {
      for (const line of lines(forbidden)) assert.equal(prompt.includes(line), false, `leaked: ${line.slice(0, 60)}`);
    }
    for (const word of ['Planner', 'Auditor', 'pipeline', 'orchestrator', 'reviewer', 'verdict', 'approve_plan']) {
      assert.equal(prompt.toLowerCase().includes(word.toLowerCase()), false, `the Executor prompt names "${word}"`);
    }
    // It is the executor's own instructions, the request and the plan, and nothing else.
    assert.ok(prompt.startsWith(EXECUTOR_INSTRUCTIONS));
    assert.match(prompt, /Task \(revision \d\):\nMake the widget return two\./);
    assert.match(prompt, /1\. Change widget\.js to return two \(done when: widget\(\) === 2\)/);
  }
});

test('isolation: a plan that copies the Planner’s instructions is refused before the agent sees it', async () => {
  const leaky = { ...PLAN, constraints: [PLANNER_INSTRUCTIONS.split('\n')[0] + ' ' + PLANNER_INSTRUCTIONS.split('\n')[1]] };
  const r = await runPipeline({ plan: leaky });
  assert.equal(r.job.status, 'failed');
  assert.match(r.job.error, /brief would have carried text it must not see/);
  assert.equal(r.sent.length, 0, 'nothing was sent to the agent');
  assert.equal(r.workspaces.get(r.taskId).status, 'released');
});

test('isolation: renderExecutorBrief reads only the executor projection’s fields', () => {
  const brief = renderExecutorBrief({ role_instructions: 'Do the work.', revision: '2', request: 'Fix it.', feedback: ['Add a test.'],
    capabilities: [{ name: 'edit' }], plan: { goal: 'G', steps: [{ n: 1, do: 'Step' }] },
    // Anything else on the object is ignored: the projection is the allowlist.
    orchestrator: PIPELINE_META, role_name: 'Planner', meta: PLANNER_INSTRUCTIONS });
  assert.equal(brief.includes(PIPELINE_META), false);
  assert.equal(brief.includes('Planner'), false);
  assert.match(brief, /Fix from the last round:\n- Add a test\./);
});

test('pipelineView is null for any job the pipeline did not drive', () => {
  assert.equal(pipelineView({ artifacts: [], stages: [] }), null);
  assert.equal(pipelineView({ artifacts: [{ kind: 'test-report', revision: 1, passed: true }], stages: [] }), null);
});

// ── with #703's real verifier module (code-verify.cjs), over an in-process fake socket ──────────

const { EventEmitter } = require('node:events');
const { createCodeVerify } = require('./code-verify.cjs');
/** A verifier container stand-in: answers each request with the next scripted outcome. */
function socketVerifier(script) {
  const requests = [];
  const connectFn = () => {
    const s = Object.assign(new EventEmitter(), { setEncoding() {}, destroy() {}, write(line) {
      const req = JSON.parse(line);
      requests.push(req);
      const next = script.shift() ?? { exitCode: 0 };
      const answer = typeof next === 'function' ? next(req)
        : { noevia: 'verify-result', nonce: req.nonce, ok: true, headSha: req.headSha, exitCode: next.exitCode, tail: next.exitCode ? 'not ok 1\n' : 'ok 1\n', ...next };
      setImmediate(() => s.emit('data', JSON.stringify(answer) + '\n'));
    } });
    return s;
  };
  return { requests, verify: createCodeVerify({ endpoint: 'unix:/run/noevia-verify/verify.sock', connectFn, connectRetryMs: 0 }) };
}

test('#703 wired: the real verifier module measures each revision at its head; a fail loops, a pass merges', async () => {
  const { verify, requests } = socketVerifier([{ exitCode: 1 }, { exitCode: 0 }]);
  const r = await runPipeline({ verify, verdicts: ['approve'] });
  assert.equal(r.job.status, 'completed', r.job.error);
  assert.deepEqual(r.stagePath, ['planned', 'implementing', 'verifying', 'changes_requested', 'implementing', 'verifying', 'reviewing', 'merged']);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map((q) => q.headSha), r.view.pipeline.evidence.map((e) => e.headSha), 'each request names that revision’s head');
  assert.ok(requests.every((q) => q.noevia === 'verify' && q.repo === 'fixture' && fs.realpathSync(q.source) === fs.realpathSync(r.source) && !('command' in q)),
    'noevia sends a repository, a source and a commit — never a command');
  assert.deepEqual(r.view.pipeline.evidence.map((e) => e.tests.passed), [false, true]);
  assert.equal(r.main, r.job.revision.headSha);
});

test('#703 wired: a busy, mismatched or refused verifier blocks the task, never passes it', async () => {
  const busy = await runPipeline({ verify: socketVerifier([(req) => ({ noevia: 'verify-result', nonce: req.nonce, ok: false, error: 'busy', message: 'busy' })]).verify });
  assert.deepEqual(busy.stagePath, ['planned', 'implementing', 'verifying', 'blocked']);
  assert.match(busy.job.error, /Verification is unavailable/);
  const other = await runPipeline({ verify: socketVerifier([(req) => ({ noevia: 'verify-result', nonce: req.nonce, ok: true, headSha: 'f'.repeat(40), exitCode: 0, tail: '' })]).verify });
  assert.deepEqual(other.stagePath, ['planned', 'implementing', 'verifying', 'blocked']);
  assert.match(other.job.error, /Verification could not run/);
  const replay = await runPipeline({ verify: socketVerifier([(req) => ({ noevia: 'verify-result', nonce: 'ab'.repeat(16), ok: true, headSha: req.headSha, exitCode: 0, tail: '' })]).verify });
  assert.match(replay.job.error, /Verification could not run/);
  const unset = await runPipeline({ verify: createCodeVerify({ endpoint: null }) });
  assert.match(unset.job.error, /Verification is not available/);
  for (const r of [busy, other, replay, unset]) assert.equal(r.main, r.job.checkpoint.baseSha, 'nothing merged');
});

// ── #715 review: what the accept card offers, and what accepting does ───────────────────────────

test('a base checked out in the owner’s tree is never merged: the card is accept-only and says how to merge by hand', async () => {
  const r = await runPipeline({ detach: false });
  const card = r.asked.find((a) => a.action === REVIEW_ACTION);
  assert.equal(card.merge, null);
  assert.equal(card.mergeWithheld.code, 'checked_out');
  assert.match(card.reason, /nothing is merged\. Merging is not offered: main is checked out in .*git merge --ff-only [0-9a-f]{40}/);
  assert.equal(r.job.status, 'completed');
  assert.deepEqual({ accepted: r.job.result.accepted, merged: r.job.result.merged, withheld: r.job.result.mergeWithheld }, { accepted: true, merged: false, withheld: 'checked_out' });
  assert.equal(r.main, r.job.checkpoint.baseSha);
  assert.equal(r.job.lifecycle, 'reviewing');
});

test('merge is offered only for a complete audit; otherwise the card is accept-only with the audit’s reasons', async () => {
  // An unresolved tool result makes the audit incomplete (everything else passes).
  const wrapJobs = (jobs) => ({ ...jobs, get: (id) => { const j = jobs.get(id); return j && j.revision ? { ...j, uncertain: [{ id: 'synthetic' }] } : j; } });
  const r = await runPipeline({ wrapJobs });
  const card = r.asked.find((a) => a.action === REVIEW_ACTION);
  assert.equal(card.audit.overall, 'incomplete');
  assert.equal(card.merge, null);
  assert.equal(card.mergeWithheld.code, 'audit_incomplete');
  assert.match(card.reason, /audit is incomplete \(nothing-unresolved: /);
  assert.equal(r.job.result.merged, false);
  assert.equal(r.main, r.job.checkpoint.baseSha);
});

test('codeMerge is read again at accept time: switched off while the card waited, nothing is merged and the result says so', async () => {
  let on = true;
  const r = await runPipeline({ merge: () => on, onAccept: async () => { on = false; } });
  const card = r.asked.find((a) => a.action === REVIEW_ACTION);
  assert.ok(card.merge, 'the card offered the merge');
  assert.equal(r.job.status, 'completed');
  assert.deepEqual({ accepted: r.job.result.accepted, merged: r.job.result.merged, note: r.job.result.note }, { accepted: true, merged: false, note: 'merge-turned-off' });
  assert.match(r.job.result.noteText, /Merging was turned off/);
  assert.equal(r.main, r.job.checkpoint.baseSha);
  assert.equal(r.job.lifecycle, 'reviewing');
});

test('a merge that happened but whose stage could not be recorded reports merged with a record-failed note', async () => {
  const wrapJobs = (jobs) => ({ ...jobs, append: (id, type, data, auth) => {
    if (type === 'task.stage' && data?.to === 'merged') throw Object.assign(Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    return jobs.append(id, type, data, auth);
  } });
  const r = await runPipeline({ wrapJobs });
  assert.equal(r.job.status, 'completed', r.job.error);
  assert.deepEqual({ merged: r.job.result.merged, note: r.job.result.note }, { merged: true, note: 'record-failed' });
  assert.equal(r.main, r.job.revision.headSha, 'main did move');
  assert.equal(r.job.lifecycle, 'reviewing', 'the stage that failed to write is not invented');
});

test('pinModel gets the task’s signal: a pin stuck in admission is ended by the plan deadline or by a cancel', async () => {
  let seen = null;
  const stuck = await runPipeline({ deadlines: { plan: 40 }, pin: ({ signal }) => { seen = signal; return new Promise(() => {}); } });
  assert.equal(stuck.job.status, 'failed');
  assert.match(stuck.job.error, /The plan stage did not finish within 1 minute\.$/);
  assert.equal(seen.aborted, true, 'the signal handed to pinModel was aborted');
  assert.deepEqual(stuck.stagePath, ['planned', 'blocked']);
  assert.equal(stuck.workspaces.get(stuck.taskId).status, 'released');
  const cancelled = await runPipeline({ pin: ({ control }) => { setTimeout(() => control.cancel(), 10); return new Promise(() => {}); } });
  assert.equal(cancelled.job.status, 'cancelled');
  assert.equal(cancelled.job.lifecycle, 'blocked');
});

test('#1157: a task blocked before the agent starts still carries its prompt and branch', async () => {
  const run = await runPipeline({ pin: async () => ({ ok: false, reason: 'no model is loaded' }) });
  assert.equal(run.job.status, 'failed');
  assert.match(run.job.error, /No model was pinned for this task: no model is loaded/);
  assert.equal(run.sent.length, 0, 'the agent never started');
  assert.equal(run.view.task, 'Make the widget return two.');
  assert.equal(typeof run.view.branch, 'string');
  assert.ok(run.view.branch.length > 0);
  assert.equal(run.view.baseSha, git(run.source, 'rev-parse', 'main'));
  const long = await runPipeline({ pin: async () => ({ ok: false, reason: 'x' }) });
  assert.ok(long.view.task.length <= 120);
});
