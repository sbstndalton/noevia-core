// The Auditor (#705): the deterministic report, the strict write-up reader, the per-revision view,
// and the verify adapter's distrust. Synthetic data only.
const test = require('node:test'), assert = require('node:assert/strict');
const { buildAuditReport, readAudit, pipelineView, AUDIT_SCHEMA, AuditWriteUpError } = require('./auditor-report.cjs');
const { createVerifyAdapter } = require('./code-pipeline-verify.cjs');

const HEAD = 'a'.repeat(40), OLD = 'b'.repeat(40), BASE = 'c'.repeat(40), PLAN = 'd'.repeat(64), REPORT = 'e'.repeat(64);
function job(overrides = {}) {
  return {
    revision: { n: 2, headSha: HEAD, planHash: PLAN },
    stages: [{ to: 'reviewing', revision: 1, reportHash: REPORT }, { to: 'reviewing', revision: 2, reportHash: REPORT }],
    artifacts: [
      { kind: 'pipeline', maxLoops: 2, merge: true },
      { kind: 'plan', revision: 1, planHash: PLAN, plan: { goal: 'g' } },
      { kind: 'revision', revision: 1, headSha: OLD, baseSha: BASE },
      { kind: 'test-report', revision: 1, headSha: OLD, passed: false, exitCode: 1, tail: 'not ok' },
      { kind: 'plan', revision: 2, planHash: PLAN, plan: { goal: 'g' } },
      { kind: 'revision', revision: 2, headSha: HEAD, baseSha: BASE },
      { kind: 'test-report', revision: 2, headSha: HEAD, passed: true, exitCode: 0, tail: 'ok', durationMs: 12 },
      { kind: 'review-verdict', revision: 2, headSha: HEAD, verdict: 'approve', summary: 's', findings: [] },
    ],
    uncertain: [], pendingApproval: null,
    ...overrides,
  };
}

test('a revision with all its evidence bound to its head audits complete', () => {
  const r = buildAuditReport({ job: job(), revision: 2, headSha: HEAD, baseSha: BASE, planHash: PLAN, branchTip: HEAD });
  assert.equal(r.overall, 'complete', JSON.stringify(r.checks));
  assert.deepEqual(r.checks.map((c) => c.name), ['revision-bound', 'plan-recorded', 'tests-measured', 'completeness-gate', 'review-bound', 'head-unchanged', 'nothing-unresolved']);
  assert.deepEqual(r.evidence.tests, { passed: true, exitCode: 0, timedOut: false, durationMs: 12, headSha: HEAD });
});

test('evidence from another revision or head never counts for this one', () => {
  const cases = [
    [{ revision: { n: 1, headSha: OLD } }, 'revision-bound'],
    [{ artifacts: job().artifacts.filter((a) => !(a.kind === 'test-report' && a.revision === 2)) }, 'tests-measured'],
    [{ artifacts: job().artifacts.map((a) => (a.kind === 'test-report' && a.revision === 2 ? { ...a, headSha: OLD } : a)) }, 'tests-measured'],
    [{ artifacts: job().artifacts.map((a) => (a.kind === 'review-verdict' ? { ...a, revision: 1 } : a)) }, 'review-bound'],
    [{ artifacts: job().artifacts.map((a) => (a.kind === 'review-verdict' ? { ...a, verdict: 'request_changes' } : a)) }, 'review-bound'],
    [{ stages: [{ to: 'reviewing', revision: 1, reportHash: REPORT }] }, 'completeness-gate'],
    [{ artifacts: job().artifacts.filter((a) => !(a.kind === 'plan' && a.revision === 2)) }, 'plan-recorded'],
    [{ uncertain: [{ id: 'x' }] }, 'nothing-unresolved'],
  ];
  for (const [over, failing] of cases) {
    const r = buildAuditReport({ job: job(over), revision: 2, headSha: HEAD, baseSha: BASE, planHash: PLAN, branchTip: HEAD });
    assert.equal(r.overall, 'incomplete', failing);
    assert.equal(r.checks.find((c) => c.name === failing).status, 'fail', failing);
  }
  const moved = buildAuditReport({ job: job(), revision: 2, headSha: HEAD, planHash: PLAN, branchTip: OLD });
  assert.equal(moved.checks.find((c) => c.name === 'head-unchanged').status, 'fail');
  const unknown = buildAuditReport({ job: job(), revision: 2, headSha: HEAD, planHash: PLAN, branchTip: null });
  assert.equal(unknown.checks.find((c) => c.name === 'head-unchanged').status, 'unknown');
  assert.equal(unknown.overall, 'incomplete', 'unknown is not complete');
  const otherPlan = buildAuditReport({ job: job(), revision: 2, headSha: HEAD, planHash: 'f'.repeat(64), branchTip: HEAD });
  assert.equal(otherPlan.checks.find((c) => c.name === 'plan-recorded').status, 'fail');
});

test('the write-up is read strictly: completeness and evidence only, no verdict, approval or extra field', () => {
  const ok = readAudit({ completeness: 'incomplete', summary: '  Tests ran.\u001b[31m ', evidence: [{ source: 'tests', note: 'exit 0' }], gaps: ['no docs', ''] });
  assert.deepEqual(ok, { completeness: 'incomplete', summary: 'Tests ran.[31m', evidence: [{ source: 'tests', note: 'exit 0' }], gaps: ['no docs'] });
  const bad = [
    { completeness: 'complete', summary: 'x', evidence: [], gaps: [], verdict: 'approve' },
    { completeness: 'complete', summary: 'x', evidence: [], gaps: [], accept: true },
    { completeness: 'merged', summary: 'x', evidence: [], gaps: [] },
    { completeness: 'complete', summary: '', evidence: [], gaps: [] },
    { completeness: 'complete', summary: 'x', evidence: [{ source: 'approval', note: 'n' }], gaps: [] },
    { completeness: 'complete', summary: 'x', evidence: [{ source: 'tests', note: 'n', grant: 'all' }], gaps: [] },
    { completeness: 'complete', summary: 'x', evidence: Array(13).fill({ source: 'tests', note: 'n' }), gaps: [] },
    null, [],
  ];
  for (const raw of bad) assert.throws(() => readAudit(raw), AuditWriteUpError, JSON.stringify(raw));
  assert.equal(AUDIT_SCHEMA.additionalProperties, false);
  assert.equal(AUDIT_SCHEMA.properties.evidence.items.additionalProperties, false);
});

test('pipelineView: plan, evidence per revision (SHAs, tests, review, completeness) and the audit', () => {
  const v = pipelineView({ ...job(), artifacts: [...job().artifacts, { kind: 'audit-report', revision: 2, headSha: HEAD, overall: 'complete', checks: [{ name: 'x', status: 'pass' }], evidence: {}, writeUp: null }] });
  assert.equal(v.maxLoops, 2);
  assert.equal(v.merge, true);
  assert.equal(v.plan.revision, 2);
  assert.deepEqual(v.evidence.map((e) => [e.revision, e.headSha, e.baseSha, e.tests.passed, e.review?.verdict ?? null, e.completeness?.reportHash ?? null]),
    [[1, OLD, BASE, false, null, REPORT], [2, HEAD, BASE, true, 'approve', REPORT]]);
  assert.equal(v.evidence[1].tests.tail, 'ok');
  assert.equal(v.audit.overall, 'complete');
  const big = pipelineView({ ...job(), artifacts: [...job().artifacts, { kind: 'test-report', revision: 3, headSha: HEAD, passed: true, tail: 'x'.repeat(40000) }] });
  assert.ok(Buffer.byteLength(big.evidence[2].tests.tail) <= 16 * 1024);
  assert.equal(big.evidence[2].tests.truncated, true);
});

test('verify adapter: only a report the verifier measured for this task, head and revision is a result', async () => {
  const measured = new WeakSet();
  const report = (extra = {}) => { const r = Object.freeze({ kind: 'test-report', passed: true, taskId: 't', headSha: HEAD, revision: 1, ...extra }); measured.add(r); return r; };
  const verifier = (outcome) => ({ available: () => true, run: async () => outcome,
    isMeasured: (r, e) => measured.has(r) && r.taskId === e.taskId && r.headSha === e.headSha && r.revision === e.revision });
  const args = { taskId: 't', headSha: HEAD, revision: 1 };
  assert.equal((await createVerifyAdapter(verifier({ status: 'passed', report: report() })).run(args)).status, 'passed');
  assert.equal((await createVerifyAdapter(verifier({ status: 'failed', report: report({ passed: false }) })).run(args)).status, 'failed');
  // Status and report disagree: the report decides.
  assert.equal((await createVerifyAdapter(verifier({ status: 'passed', report: report({ passed: false }) })).run(args)).status, 'failed');
  // A lookalike report, another revision, or an unknown answer is an error, never a pass.
  assert.equal((await createVerifyAdapter(verifier({ status: 'passed', report: { kind: 'test-report', passed: true, taskId: 't', headSha: HEAD, revision: 1 } })).run(args)).error.code, 'unmeasured');
  assert.equal((await createVerifyAdapter(verifier({ status: 'passed', report: report({ revision: 0 }) })).run(args)).error.code, 'unmeasured');
  assert.equal((await createVerifyAdapter(verifier({ status: 'great' })).run(args)).status, 'error');
  assert.equal((await createVerifyAdapter({ available: () => true, isMeasured: () => true, run: async () => { throw Error('boom'); } }).run(args)).status, 'error');
  assert.equal((await createVerifyAdapter(verifier({ status: 'unavailable', error: { message: 'not configured' } })).run(args)).status, 'unavailable');
  assert.equal((await createVerifyAdapter({ available: () => false, isMeasured: () => true, run: async () => ({ status: 'passed' }) }).run(args)).status, 'unavailable');
  assert.equal(createVerifyAdapter({ run: async () => ({}) }).available(), false, 'no isMeasured: not a verifier');
});
