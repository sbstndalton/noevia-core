'use strict';
// Deterministic, model-free completeness auditor (#514, part of #511's fit-gap: "no
// completeness report"). Given a job's own derived shape (jobs.cjs `derive()`/`get()`), this
// module produces a structured report of named checks — each pass/fail/unknown with its
// evidence — and a pure guard, `canEnterReviewing()`, that a future reviewer/merge feature can
// consult before letting a task leave `implementing`/`verifying` for `reviewing` (see
// task-lifecycle.cjs).
//
// No models, no HTTP, no storage: pure functions over data the caller already has in hand.
//
// WARNING TO FUTURE AUTHORS (read before touching `tests-run`): do NOT correlate a
// `tool.started` event's agent-supplied `name`/`title`/`kind` to a later `tool.completed` by
// `id` to decide whether "tests" ran or passed. Both the `id` (the ACP protocol's own
// `toolCallId`) and the `name`/`title` on those events are supplied by the external agent the
// harness is running (code-harness.cjs:346 sets `tool.started`'s `name` straight from
// `update.title`), and `tool.completed`'s `failed`/`exitCode` (code-harness.cjs:357,
// code-meta.cjs's `readExitCode`) are the agent's own self-report of what its subprocess did —
// none of it is server-measured. An agent (or the model driving it) can report any exit code it
// likes for any command it likes; matching a "test-shaped" name to a "successful" exit code
// would launder that self-report into false proof of a real test run. `tests-run` below is
// therefore decided ONLY from (a) a `step.completed` for a closed, server-chosen set of
// test-step ids that only first-party harness code emits (the same trust boundary as
// code-harness.cjs's hardcoded `'harness.config'` step id — never a regex over agent text), or
// (b) a dedicated, explicitly-shaped test-report artifact a trusted measurement path emits.
// Neither exists in this codebase yet, so `tests-run` is honestly 'unknown' until one does —
// that is the correct, honest answer, not a bug to "fix" by reading tool.completed instead.
//
// Trust model (same "server-emitted event types only" boundary task-lifecycle.cjs's honesty
// constraint (#522) draws): every check below is decided from data jobs.cjs's own `derive()`
// already folds — `job.steps` (id/status from `step.started`/`step.completed`), `job.artifacts`
// (from `artifact.created`), `job.plan`, `job.checkpoint`, `job.uncertain`, and
// `job.pendingApproval`. No check here ever reads a free-form, caller-chosen key (e.g. a
// `testsPassed`, `review`, or `merged` flag) out of an event's `data` as proof of anything:
// `approval.requested`/`approval.decided`'s payload is the per-tool-call write-approval card,
// built by spreading page- or model-influenced content (browser-service.cjs's `{ ...card,
// jobId }`), and `job.completed`'s `result` is whatever the harness or model reported — neither
// is evidence of a real test run, review or merge, and a forged claim on either is inert here by
// construction (see the spoof-resistance tests). `tool.completed`'s `failed`/`exitCode` fields
// are excluded from every check for the same reason (see the warning above), even though they
// are "structured" fields on a server-appended event type: structure alone isn't trust when the
// content inside that structure is the agent's own self-report.
//
// This module deliberately does NOT change the derived lifecycle: `job.lifecycle` from
// jobs.cjs/task-lifecycle.cjs is unaffected by anything here, and `canEnterReviewing()` is a
// pure, read-only guard — nothing in this file appends an event, mutates `job`, or calls
// `transition()`. It is wired into task-lifecycle.cjs only as an additional guard function
// exported for a future `transition()` caller to use; today nothing calls it automatically.

const CHECK_NAMES = Object.freeze([
  'tests-run',
  'artifacts-present',
  'plan-steps-closed',
  'no-unresolved-uncertainty',
  'checkpoint-head-recorded',
]);

// A closed, server-chosen allowlist of `step.started`/`step.completed` ids a trusted, first-party
// harness would use for an actual test-execution step — analogous to code-harness.cjs's
// hardcoded `'harness.config'` step id, which the harness itself picks, never the agent it runs.
// Nothing in this repository emits any of these today, so matching against this list (rather
// than a regex over agent-supplied title text) correctly yields 'unknown' until a real
// test-running step exists. See the module-top warning before widening this.
const TEST_STEP_IDS = new Set(['tests', 'test', 'run-tests', 'test-suite']);

// The canonical shape of a server-measured test-report artifact: a dedicated, trusted
// measurement path (not a generic job-kind artifact whose `name`/content can carry model output,
// e.g. research-service.cjs's `artifact.created` names come from the model's own written files)
// would record `{ kind: 'test-report', passed: boolean, ... }`. Nothing in this repository emits
// this today either.
const TEST_ARTIFACT_KIND = 'test-report';

const CHECKPOINT_SHA_KEYS = Object.freeze(['sha', 'headSha', 'head_sha', 'commitSha', 'commit_sha', 'commit']);
const SHA_SHAPE = /^[0-9a-f]{7,40}$/i;

function check(name, status, evidence, detail) {
  return { name, status, detail, evidence };
}

// See the module-top warning: only a server-defined test step (matched by a closed id
// allowlist, never agent-supplied name/title text) or an explicit, dedicated test-report
// artifact counts as evidence here. `tool.completed`'s agent-self-reported `failed`/`exitCode`
// is never consulted, no matter what its `name`/`title` claims to be.
function testsRunCheck(job) {
  const steps = (job?.steps || []).filter((s) => TEST_STEP_IDS.has(s.id));
  const artifacts = (job?.artifacts || []).filter((a) => a && a.kind === TEST_ARTIFACT_KIND && typeof a.passed === 'boolean');
  if (!steps.length && !artifacts.length) {
    return check('tests-run', 'unknown', { steps, artifacts }, 'No server-defined test step or server-measured test-report artifact was recorded.');
  }
  if (steps.some((s) => s.status === 'failed') || artifacts.some((a) => a.passed === false)) {
    return check('tests-run', 'fail', { steps, artifacts }, 'A server-defined test step or test-report artifact recorded failure.');
  }
  if (steps.some((s) => s.status === 'running')) {
    return check('tests-run', 'unknown', { steps, artifacts }, 'A server-defined test step has not completed yet.');
  }
  return check('tests-run', 'pass', { steps, artifacts }, 'A server-defined test step or test-report artifact reports success.');
}

// `expectedArtifacts` is declared by the caller (e.g. from the job kind's own contract), never
// inferred from anything the model said. `undefined`/`null` means no expectation was declared
// for this job, which is 'unknown', not a pass — silence is not evidence.
function artifactsPresentCheck(job, expectedArtifacts) {
  const found = (job?.artifacts || []).map((a) => a?.name).filter((n) => typeof n === 'string');
  if (expectedArtifacts == null) {
    return check('artifacts-present', 'unknown', { expected: null, found }, 'No expected-artifact list was declared for this job.');
  }
  const expected = [...expectedArtifacts];
  const missing = expected.filter((name) => !found.includes(name));
  if (missing.length) {
    return check('artifacts-present', 'fail', { expected, found, missing }, `Missing expected artifact(s): ${missing.join(', ')}.`);
  }
  return check('artifacts-present', 'pass', { expected, found }, 'All expected artifacts are present.');
}

// `job.plan` and `job.steps` are exactly what jobs.cjs's own `derive()` already folds from
// `plan.proposed`/`plan.edited`/`plan.skipped` and `step.started`/`step.completed` — this check
// re-reads that same derived shape rather than re-parsing events, so it can never disagree with
// the job object a caller already has. Any step not explicitly `'completed'` blocks closure: a
// step jobs.cjs marked `'failed'` (a `step.completed` with `failed: true`, e.g.
// code-harness.cjs:104) is not closed just because it stopped running.
function planStepsClosedCheck(job) {
  const plan = job?.plan || null;
  const steps = job?.steps || [];
  if (plan && plan.status === 'skipped') {
    return check('plan-steps-closed', 'unknown', { plan, steps }, 'The plan was explicitly skipped; there are no steps to close.');
  }
  if (!plan && !steps.length) {
    return check('plan-steps-closed', 'unknown', { plan, steps }, 'No plan was proposed and no steps were recorded.');
  }
  const open = steps.filter((s) => s.status !== 'completed');
  if (open.length) {
    return check('plan-steps-closed', 'fail', { plan, steps, open }, `${open.length} step(s) are not completed (running or failed): ${open.map((s) => `${s.id}:${s.status}`).join(', ')}.`);
  }
  if (!steps.length) {
    return check('plan-steps-closed', 'unknown', { plan, steps }, 'A plan was proposed but no step events were recorded to verify closure.');
  }
  return check('plan-steps-closed', 'pass', { plan, steps }, `All ${steps.length} recorded step(s) are completed.`);
}

// `job.uncertain` (tool.uncertain events) and `job.pendingApproval` (open approval.requested with
// no matching approval.decided/terminal event yet) are both append-only bookkeeping jobs.cjs's
// own `derive()` already maintains; this never inspects the *content* of either event's `data`
// (which can carry agent/page-influenced fields) for anything beyond "does one exist".
function unresolvedCheck(job) {
  const uncertain = job?.uncertain || [];
  const pendingApproval = job?.pendingApproval || null;
  if (uncertain.length || pendingApproval) {
    const parts = [];
    if (uncertain.length) parts.push(`${uncertain.length} unresolved tool.uncertain event(s)`);
    if (pendingApproval) parts.push('a pending approval');
    return check('no-unresolved-uncertainty', 'fail', { uncertainCount: uncertain.length, pendingApproval: !!pendingApproval }, `${parts.join(' and ')} remain.`);
  }
  return check('no-unresolved-uncertainty', 'pass', { uncertainCount: 0, pendingApproval: false }, 'No unresolved uncertainty or pending approval.');
}

// The checkpoint head SHA (#513) may not exist yet on this journal's `checkpoint.created`
// events — code-harness.cjs today records only `branch`/`task`/`identityHash`/`identity`/`meta`.
// A missing SHA is therefore explicitly 'unknown', never a failure: this check cannot punish a
// job for a field #513 hasn't landed to populate.
function checkpointHeadCheck(job) {
  const checkpoint = job?.checkpoint || null;
  if (!checkpoint) {
    return check('checkpoint-head-recorded', 'unknown', { checkpoint: null }, 'No checkpoint was recorded for this job.');
  }
  const key = CHECKPOINT_SHA_KEYS.find((k) => typeof checkpoint[k] === 'string' && checkpoint[k].length > 0);
  if (!key) {
    return check('checkpoint-head-recorded', 'unknown', { checkpoint }, 'A checkpoint was recorded but carries no head SHA (expected until #513 lands).');
  }
  const sha = checkpoint[key];
  if (!SHA_SHAPE.test(sha)) {
    return check('checkpoint-head-recorded', 'fail', { checkpoint, field: key, sha }, `Checkpoint head SHA field "${key}" does not look like a commit SHA: ${JSON.stringify(sha)}.`);
  }
  return check('checkpoint-head-recorded', 'pass', { checkpoint, field: key, sha }, `Checkpoint head SHA recorded (${key}).`);
}

function overallOf(checks) {
  if (checks.some((c) => c.status === 'fail')) return 'fail';
  if (checks.some((c) => c.status === 'unknown')) return 'unknown';
  return 'pass';
}

/**
 * Build the completeness report for one job.
 * @param {{job: object, expectedArtifacts?: string[]|null}} input
 *   - `job`: the derived job shape from jobs.cjs's `derive()`/`get()` (steps, artifacts, plan,
 *     checkpoint, uncertain, pendingApproval, …). Required. Every check reads only this derived
 *     shape — never a job's raw events directly — because jobs.cjs's own `derive()` is already
 *     the single source of truth for "what happened", and re-parsing events here could disagree
 *     with it (see the module header on why `tool.completed`'s raw fields are excluded outright).
 *   - `expectedArtifacts`: names the caller expects `artifact.created` to have produced for this
 *     job. `null`/omitted means no expectation was declared (check is 'unknown', not 'pass').
 */
function buildCompletenessReport({ job, expectedArtifacts = null } = {}) {
  if (!job || typeof job !== 'object') throw Object.assign(Error('buildCompletenessReport requires a derived job'), { status: 400 });
  const checks = [
    testsRunCheck(job),
    artifactsPresentCheck(job, expectedArtifacts),
    planStepsClosedCheck(job),
    unresolvedCheck(job),
    checkpointHeadCheck(job),
  ];
  return { jobId: job.id ?? null, checks, overall: overallOf(checks) };
}

// Pure guard: false whenever any required check failed OR is unknown — "unknown" is treated the
// same as "not proven", not as a pass. True only when every check explicitly passed.
function canEnterReviewing(report) {
  if (!report || !Array.isArray(report.checks) || !report.checks.length) return false;
  return report.checks.every((c) => c.status === 'pass');
}

module.exports = { CHECK_NAMES, TEST_STEP_IDS, TEST_ARTIFACT_KIND, buildCompletenessReport, canEnterReviewing };
