'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { derive } = require('./jobs.cjs');
const { canTransitionToReviewing } = require('./task-lifecycle.cjs');
const { CHECK_NAMES, buildCompletenessReport, canEnterReviewing } = require('./completeness-report.cjs');

// --- Helpers to build synthetic journals in the exact shape jobs.cjs appends, then fold them
// through jobs.cjs's own `derive()` the same way a real caller (jobs.get(id)) would. Never real
// Diary prompts/corpus — every event stream below is invented for this module only. Event
// payload shapes below match the *real* emitters (code-harness.cjs, jobs.cjs) exactly, e.g. a
// real `tool.completed` is `{ id, failed, exitCode, content }` with no `name` field at all.
let seq = 0;
const ev = (type, data = {}) => ({ job: 'synthetic', seq: ++seq, type, at: seq, data });
function buildJob(events) { return derive(events); }
function report(events, opts = {}) { return buildCompletenessReport({ job: buildJob(events), ...opts }); }

function names(rep) { return rep.checks.map((c) => c.name).sort(); }
function statusOf(rep, name) { return rep.checks.find((c) => c.name === name).status; }

test('CHECK_NAMES matches the checks a report actually produces', () => {
  seq = 0;
  const rep = report([ev('job.created', { kind: 'chat' })]);
  assert.deepEqual(names(rep), [...CHECK_NAMES].sort());
});

// --- tests-run -------------------------------------------------------------------------------
// Only a server-defined test step (a closed id allowlist) or a dedicated test-report artifact
// counts. Never a `tool.completed`'s agent-self-reported `failed`/`exitCode`, no matter its
// (nonexistent, in the real shape) name.

test('tests-run is unknown when nothing test-shaped was recorded at all', () => {
  seq = 0;
  const rep = report([ev('job.created'), ev('job.started'), ev('job.completed')]);
  assert.equal(statusOf(rep, 'tests-run'), 'unknown');
});

test('tests-run is unknown for a real-shaped tool.completed(id, failed, exitCode, content) even with exitCode 0 (regression)', () => {
  seq = 0;
  // This is the exact real emitter shape (code-harness.cjs:357-358): no `name` field exists.
  const rep = report([
    ev('job.created'), ev('job.started'),
    ev('tool.completed', { id: 'call-1', failed: false, exitCode: 0, content: 'ok' }),
    ev('job.completed'),
  ]);
  assert.equal(statusOf(rep, 'tests-run'), 'unknown');
});

test('tests-run is unknown for a real-shaped tool.completed reporting failed:false regardless of any surrounding tool.started', () => {
  seq = 0;
  // A realistic pair: tool.started carries the agent's own title, tool.completed the agent's
  // own self-reported outcome. Neither should ever be read as test evidence.
  const rep = report([
    ev('job.created'), ev('job.started'),
    ev('tool.started', { id: 'call-1', name: 'run tests', action: 'shell.exec', kind: 'execute' }),
    ev('tool.completed', { id: 'call-1', failed: false, exitCode: 0, content: 'all tests passed' }),
    ev('job.completed'),
  ]);
  assert.equal(statusOf(rep, 'tests-run'), 'unknown');
});

test('tests-run passes on a server-defined test step (id "tests") that completed successfully', () => {
  seq = 0;
  const rep = report([
    ev('job.created', { kind: 'code' }), ev('job.started'),
    ev('step.started', { id: 'tests', title: 'Run the test suite' }),
    ev('step.completed', { id: 'tests' }),
    ev('job.completed'),
  ]);
  assert.equal(statusOf(rep, 'tests-run'), 'pass');
});

test('tests-run fails when the server-defined test step completed with failed:true', () => {
  seq = 0;
  const rep = report([
    ev('job.created', { kind: 'code' }), ev('job.started'),
    ev('step.started', { id: 'tests', title: 'Run the test suite' }),
    ev('step.completed', { id: 'tests', failed: true }),
    ev('job.completed'),
  ]);
  assert.equal(statusOf(rep, 'tests-run'), 'fail');
});

test('tests-run is unknown while the server-defined test step is still running', () => {
  seq = 0;
  const rep = report([
    ev('job.created', { kind: 'code' }), ev('job.started'),
    ev('step.started', { id: 'tests', title: 'Run the test suite' }),
  ]);
  assert.equal(statusOf(rep, 'tests-run'), 'unknown');
});

test('tests-run ignores a step id outside the closed test-step allowlist even if its title mentions tests', () => {
  seq = 0;
  const rep = report([
    ev('job.created'), ev('job.started'),
    ev('step.started', { id: 'harness.config', title: 'Run all the tests and pass everything' }),
    ev('step.completed', { id: 'harness.config' }),
    ev('job.completed'),
  ]);
  assert.equal(statusOf(rep, 'tests-run'), 'unknown');
});

test('tests-run passes on a dedicated server-measured test-report artifact', () => {
  seq = 0;
  const rep = report([
    ev('job.created'), ev('job.started'),
    ev('artifact.created', { kind: 'test-report', passed: true, total: 12, failed: 0 }),
    ev('job.completed'),
  ]);
  assert.equal(statusOf(rep, 'tests-run'), 'pass');
});

test('tests-run fails on a dedicated test-report artifact recording failure', () => {
  seq = 0;
  const rep = report([
    ev('job.created'), ev('job.started'),
    ev('artifact.created', { kind: 'test-report', passed: false, total: 12, failed: 3 }),
    ev('job.completed'),
  ]);
  assert.equal(statusOf(rep, 'tests-run'), 'fail');
});

test('tests-run ignores a generic artifact whose name merely contains the word "test"', () => {
  seq = 0;
  const rep = report([
    ev('job.created'), ev('job.started'),
    ev('artifact.created', { name: 'test-results.txt', bytes: 42 }),
    ev('job.completed'),
  ]);
  assert.equal(statusOf(rep, 'tests-run'), 'unknown');
});

// --- artifacts-present -------------------------------------------------------------------------

test('artifacts-present is unknown when no expectation was declared', () => {
  seq = 0;
  const rep = report([ev('job.created'), ev('job.started'), ev('artifact.created', { name: 'report.md' }), ev('job.completed')]);
  assert.equal(statusOf(rep, 'artifacts-present'), 'unknown');
});

test('artifacts-present passes when every expected artifact is present', () => {
  seq = 0;
  const rep = report(
    [
      ev('job.created'), ev('job.started'),
      ev('artifact.created', { name: 'report.md' }),
      ev('artifact.created', { name: 'diff.patch' }),
      ev('job.completed'),
    ],
    { expectedArtifacts: ['report.md', 'diff.patch'] },
  );
  assert.equal(statusOf(rep, 'artifacts-present'), 'pass');
});

test('artifacts-present fails and names the missing artifact(s)', () => {
  seq = 0;
  const rep = report(
    [ev('job.created'), ev('job.started'), ev('artifact.created', { name: 'report.md' }), ev('job.completed')],
    { expectedArtifacts: ['report.md', 'diff.patch'] },
  );
  const c = rep.checks.find((x) => x.name === 'artifacts-present');
  assert.equal(c.status, 'fail');
  assert.deepEqual(c.evidence.missing, ['diff.patch']);
});

test('artifacts-present passes vacuously when an empty expectation list is explicitly declared', () => {
  seq = 0;
  const rep = report([ev('job.created'), ev('job.started'), ev('job.completed')], { expectedArtifacts: [] });
  assert.equal(statusOf(rep, 'artifacts-present'), 'pass');
});

// --- plan-steps-closed -------------------------------------------------------------------------

test('plan-steps-closed is unknown when no plan and no steps were recorded', () => {
  seq = 0;
  const rep = report([ev('job.created'), ev('job.started'), ev('job.completed')]);
  assert.equal(statusOf(rep, 'plan-steps-closed'), 'unknown');
});

test('plan-steps-closed is unknown when the plan was explicitly skipped', () => {
  seq = 0;
  const rep = report([ev('job.created', { kind: 'code' }), ev('job.started'), ev('plan.skipped', { question: 'q' }), ev('job.completed')]);
  assert.equal(statusOf(rep, 'plan-steps-closed'), 'unknown');
});

test('plan-steps-closed passes when every started step also completed successfully', () => {
  seq = 0;
  const rep = report([
    ev('job.created', { kind: 'code' }), ev('job.started'),
    ev('plan.proposed', { subQuestions: ['do the thing'] }),
    ev('step.started', { id: 's1', title: 'harness.config' }),
    ev('step.completed', { id: 's1' }),
    ev('job.completed'),
  ]);
  assert.equal(statusOf(rep, 'plan-steps-closed'), 'pass');
});

test('plan-steps-closed fails when a step started but never completed', () => {
  seq = 0;
  const rep = report([
    ev('job.created', { kind: 'code' }), ev('job.started'),
    ev('plan.proposed', { subQuestions: ['do the thing'] }),
    ev('step.started', { id: 's1', title: 'harness.config' }),
    // no matching step.completed
  ]);
  const c = rep.checks.find((x) => x.name === 'plan-steps-closed');
  assert.equal(c.status, 'fail');
  assert.deepEqual(c.evidence.open.map((s) => s.id), ['s1']);
});

test('plan-steps-closed fails when a step completed with failed:true and nothing is still running (review finding)', () => {
  seq = 0;
  const rep = report([
    ev('job.created', { kind: 'code' }), ev('job.started'),
    ev('plan.proposed', { subQuestions: ['do the thing'] }),
    ev('step.started', { id: 'harness.config', title: 'Pin the harness configuration' }),
    ev('step.completed', { id: 'harness.config', failed: true, error: 'config write failed' }),
    ev('job.failed', { error: 'boom' }),
  ]);
  const c = rep.checks.find((x) => x.name === 'plan-steps-closed');
  assert.equal(c.status, 'fail');
  assert.deepEqual(c.evidence.open.map((s) => s.id), ['harness.config']);
  assert.equal(c.evidence.open[0].status, 'failed');
});

test('plan-steps-closed is unknown when a plan was proposed but no step events exist at all', () => {
  seq = 0;
  const rep = report([ev('job.created', { kind: 'code' }), ev('job.started'), ev('plan.proposed', { subQuestions: ['x'] })]);
  assert.equal(statusOf(rep, 'plan-steps-closed'), 'unknown');
});

// --- no-unresolved-uncertainty -------------------------------------------------------------------------

test('no-unresolved-uncertainty passes on a clean journal', () => {
  seq = 0;
  const rep = report([ev('job.created'), ev('job.started'), ev('job.completed')]);
  assert.equal(statusOf(rep, 'no-unresolved-uncertainty'), 'pass');
});

test('no-unresolved-uncertainty fails when a tool.uncertain event was ever recorded', () => {
  seq = 0;
  const rep = report([ev('job.created'), ev('job.started'), ev('tool.uncertain', { reason: 'ambiguous result' }), ev('job.completed')]);
  assert.equal(statusOf(rep, 'no-unresolved-uncertainty'), 'fail');
});

test('no-unresolved-uncertainty fails while an approval is still pending', () => {
  seq = 0;
  const rep = report([ev('job.created'), ev('job.started'), ev('approval.requested', { action: 'shell.exec' })]);
  assert.equal(statusOf(rep, 'no-unresolved-uncertainty'), 'fail');
});

test('no-unresolved-uncertainty passes once the pending approval is decided', () => {
  seq = 0;
  const rep = report([
    ev('job.created'), ev('job.started'),
    ev('approval.requested', { action: 'shell.exec' }),
    ev('approval.decided', { decision: 'approve' }),
    ev('job.completed'),
  ]);
  assert.equal(statusOf(rep, 'no-unresolved-uncertainty'), 'pass');
});

// --- checkpoint-head-recorded -------------------------------------------------------------------------

test('checkpoint-head-recorded is unknown when no checkpoint exists', () => {
  seq = 0;
  const rep = report([ev('job.created'), ev('job.started'), ev('job.completed')]);
  assert.equal(statusOf(rep, 'checkpoint-head-recorded'), 'unknown');
});

test('checkpoint-head-recorded is unknown (not failing) when a checkpoint exists without a SHA (pre-#513 shape)', () => {
  seq = 0;
  const rep = report([
    ev('job.created', { kind: 'code' }), ev('job.started'),
    ev('checkpoint.created', { branch: 'task/abc', task: 'do the thing' }),
    ev('job.completed'),
  ]);
  assert.equal(statusOf(rep, 'checkpoint-head-recorded'), 'unknown');
});

test('checkpoint-head-recorded passes once a well-formed head SHA is recorded', () => {
  seq = 0;
  const rep = report([
    ev('job.created', { kind: 'code' }), ev('job.started'),
    ev('checkpoint.created', { branch: 'task/abc', sha: 'a1b2c3d4e5f6' }),
    ev('job.completed'),
  ]);
  assert.equal(statusOf(rep, 'checkpoint-head-recorded'), 'pass');
});

test('checkpoint-head-recorded fails when a SHA field is present but malformed', () => {
  seq = 0;
  const rep = report([
    ev('job.created', { kind: 'code' }), ev('job.started'),
    ev('checkpoint.created', { branch: 'task/abc', headSha: 'not-a-sha!' }),
    ev('job.completed'),
  ]);
  assert.equal(statusOf(rep, 'checkpoint-head-recorded'), 'fail');
});

test('checkpoint-head-recorded reflects the latest checkpoint.created event', () => {
  seq = 0;
  const rep = report([
    ev('job.created', { kind: 'code' }), ev('job.started'),
    ev('checkpoint.created', { branch: 'task/abc' }),
    ev('checkpoint.created', { branch: 'task/abc', sha: 'deadbeef' }),
    ev('job.completed'),
  ]);
  assert.equal(statusOf(rep, 'checkpoint-head-recorded'), 'pass');
});

// --- canEnterReviewing guard -------------------------------------------------------------------------

function fullyPassingEvents() {
  return [
    ev('job.created', { kind: 'code' }), ev('job.started'),
    ev('step.started', { id: 'tests', title: 'Run the test suite' }),
    ev('step.completed', { id: 'tests' }),
    ev('artifact.created', { name: 'report.md' }),
    ev('step.started', { id: 's1', title: 'harness.config' }),
    ev('step.completed', { id: 's1' }),
    ev('checkpoint.created', { sha: 'deadbeef' }),
    ev('job.completed'),
  ];
}

test('canEnterReviewing is false when any check is unknown', () => {
  seq = 0;
  const rep = report([ev('job.created'), ev('job.started'), ev('job.completed')]);
  assert.equal(rep.overall, 'unknown');
  assert.equal(canEnterReviewing(rep), false);
});

test('canEnterReviewing is false when any check fails, even if others pass', () => {
  seq = 0;
  const rep = report(
    [...fullyPassingEvents(), ev('tool.uncertain', { reason: 'ambiguous' })],
    { expectedArtifacts: ['report.md'] },
  );
  assert.equal(rep.overall, 'fail');
  assert.equal(canEnterReviewing(rep), false);
});

test('canEnterReviewing is true only when every check explicitly passes', () => {
  seq = 0;
  const rep = report(fullyPassingEvents(), { expectedArtifacts: ['report.md'] });
  assert.equal(rep.overall, 'pass');
  assert.equal(canEnterReviewing(rep), true);
});

test('canEnterReviewing is false on an empty/malformed report', () => {
  assert.equal(canEnterReviewing(null), false);
  assert.equal(canEnterReviewing({}), false);
  assert.equal(canEnterReviewing({ checks: [] }), false);
});

test('buildCompletenessReport requires a job object', () => {
  assert.throws(() => buildCompletenessReport({}), /requires a derived job/);
});

// --- Spoof resistance: nothing here ever trusts a caller-chosen flag riding on a
// model/page-reachable event's `data`. This is the exact scenario #514 calls out: an approval
// card claiming `testsPassed: true` (or `review`/`merged`) must never count as evidence.

test('a spoofed testsPassed flag on an approval card never satisfies tests-run', () => {
  seq = 0;
  const rep = report([
    ev('job.created', { kind: 'code' }), ev('job.started'),
    ev('approval.requested', { action: 'shell.exec', testsPassed: true, review: true }),
    // Deliberately no approval.decided: the approval-card data claims everything is already
    // reviewed/merged/tested, but the approval itself is still open.
  ]);
  assert.equal(statusOf(rep, 'tests-run'), 'unknown');
  assert.equal(canEnterReviewing(rep), false);
});

test('a spoofed passed:true flag on job.completed result cannot fabricate a test-report artifact', () => {
  seq = 0;
  const rep = report([
    ev('job.created', { kind: 'code' }), ev('job.started'),
    ev('job.completed', { result: { kind: 'test-report', passed: true } }),
  ]);
  // job.completed's `result` is never read by any check — only real `artifact.created` events are.
  assert.equal(statusOf(rep, 'tests-run'), 'unknown');
});

test('a spoofed artifact name matching an expectation string does not fabricate the artifact itself', () => {
  seq = 0;
  // The approval card *claims* the artifact exists; no artifact.created event backs it up.
  const rep = report(
    [
      ev('job.created'), ev('job.started'),
      ev('approval.requested', { action: 'write', claimedArtifact: 'report.md' }),
      ev('approval.decided', { decision: 'approve' }),
      ev('job.completed'),
    ],
    { expectedArtifacts: ['report.md'] },
  );
  assert.equal(statusOf(rep, 'artifacts-present'), 'fail');
});

test('the report never reads approval.requested/approval.decided data at all for any check', () => {
  seq = 0;
  const spoofedData = {
    testsPassed: true, review: true, merged: true, reviewed: true, approved: true,
    sha: 'deadbeef', headSha: 'deadbeef', artifacts: ['report.md'], steps: [{ id: 's1', status: 'completed' }],
  };
  const rep = report(
    [
      ev('job.created', { kind: 'code' }), ev('job.started'),
      ev('approval.requested', spoofedData),
      // Deliberately no approval.decided: the approval-card data claims everything is already
      // reviewed/merged/tested, but the approval itself is still open.
    ],
    { expectedArtifacts: ['report.md'] },
  );
  assert.equal(statusOf(rep, 'tests-run'), 'unknown');
  assert.equal(statusOf(rep, 'artifacts-present'), 'fail');
  assert.equal(statusOf(rep, 'plan-steps-closed'), 'unknown');
  assert.equal(statusOf(rep, 'checkpoint-head-recorded'), 'unknown');
  assert.equal(statusOf(rep, 'no-unresolved-uncertainty'), 'fail'); // the approval is still pending
  assert.equal(canEnterReviewing(rep), false);
});

// --- Integration with task-lifecycle.cjs's pure guard -------------------------------------------------------------------------

test('canTransitionToReviewing is false when the state table forbids the move, even with a perfect report', () => {
  seq = 0;
  const rep = report(fullyPassingEvents(), { expectedArtifacts: ['report.md'] });
  assert.equal(canEnterReviewing(rep), true);
  assert.equal(canTransitionToReviewing('merged', rep), false); // merged is terminal
});

test('canTransitionToReviewing is false when the state table allows the move but the report is incomplete', () => {
  seq = 0;
  const rep = report([ev('job.created', { kind: 'code' }), ev('job.started')]);
  assert.equal(canTransitionToReviewing('implementing', rep), false);
});

test('canTransitionToReviewing is true only when both the state table and the report agree', () => {
  seq = 0;
  const rep = report(fullyPassingEvents(), { expectedArtifacts: ['report.md'] });
  assert.equal(canTransitionToReviewing('implementing', rep), true);
});

test("canTransitionToReviewing never changes the derived lifecycle itself (#522's guarantee holds)", () => {
  seq = 0;
  const { deriveLifecycle } = require('./task-lifecycle.cjs');
  const events = fullyPassingEvents();
  const rep = report(events, { expectedArtifacts: ['report.md'] });
  canTransitionToReviewing('implementing', rep); // calling the guard must not mutate anything
  assert.equal(deriveLifecycle(events), 'verifying'); // never 'reviewing', exactly as #522 requires
});
