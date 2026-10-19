'use strict';
// COMPLETENESS_REPORT_IMPL (retired in #1071: the port always confirms the JS): the fail-closed paths, with a stand-in for the Rust port
// (no dav-parse.wasm needed; tests/server/completeness-report-differential.test.cjs runs the real
// module). The JS report is handed out as is only when the port returns the byte-identical
// canonical report and hash; anything else marks it unverified, which canEnterReviewing() refuses
// and which never turns a JS "fail" into anything else. Synthetic jobs only.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cr = require('./completeness-report.cjs');
const davParseWasm = require('./dav-parse-wasm.cjs');

const { buildCompletenessReport, buildCompletenessReportJs, canEnterReviewing, reportHash } = cr;

const SHA = 'b'.repeat(40);
const passingJob = () => ({
  id: 'job-pass', steps: [{ id: 'tests', title: 'Run tests', status: 'completed' }], artifacts: [{ name: 'patch.diff' }],
  plan: { status: 'proposed' }, uncertain: [], pendingApproval: null, checkpoint: { sha: SHA },
});
const failingJob = () => ({ ...passingJob(), steps: [{ id: 'tests', status: 'failed' }] });

// Key-sorted JSON, as the port's reply carries the report.
const sorted = (v) => (v && typeof v === 'object'
  ? (Array.isArray(v) ? v.map(sorted) : Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])))
  : v);

/** A port that answers as the JS does (from the JS itself), with `over` replacing the call. */
function fakePort(over) {
  const calls = [];
  const port = {
    completenessReport: over || ((job, expected) => {
      calls.push([job, expected]);
      const r = buildCompletenessReportJs({ job: JSON.parse(JSON.stringify(job)), expectedArtifacts: expected });
      return { hash: reportHash(r), report: sorted(JSON.parse(JSON.stringify(r))) };
    }),
  };
  return { loader: () => port, calls };
}
const wasm = (port) => ({ wasmLoader: port.loader });

function quietly(fn) {
  const warn = console.warn, seen = [];
  console.warn = (m) => seen.push(String(m));
  try { return { value: fn(), seen }; } finally { console.warn = warn; }
}

test('COMPLETENESS_REPORT_IMPL is retired: no switch, the port is always asked, an old =js changes nothing', () => {
  assert.equal(cr.completenessReportImpl, undefined);
  assert.ok(!davParseWasm.IMPL_FLAGS.includes('COMPLETENESS_REPORT_IMPL'));
  assert.equal(davParseWasm.RETIRED_FLAGS.COMPLETENESS_REPORT_IMPL, 'wasm');
  const port = fakePort();
  // `env` and `impl` are not options any more; whatever an old caller passes, the port is asked.
  buildCompletenessReport({ job: passingJob(), expectedArtifacts: ['patch.diff'] }, { env: { COMPLETENESS_REPORT_IMPL: 'js' }, impl: 'js', wasmLoader: port.loader });
  assert.deepEqual(port.calls, [[passingJob(), ['patch.diff']]]);
  const saved = process.env.COMPLETENESS_REPORT_IMPL;
  process.env.COMPLETENESS_REPORT_IMPL = 'js';
  try {
    buildCompletenessReport({ job: passingJob() }, { wasmLoader: port.loader });
  } finally { if (saved === undefined) delete process.env.COMPLETENESS_REPORT_IMPL; else process.env.COMPLETENESS_REPORT_IMPL = saved; }
  assert.deepEqual(port.calls[1][1], null, 'an omitted expectedArtifacts crosses as null');
});

test('an agreeing port: the JS report is handed out unchanged, pass and fail alike', () => {
  for (const [job, expected] of [[passingJob(), ['patch.diff']], [failingJob(), null], [{}, null], [passingJob(), ['missing']]]) {
    const js = buildCompletenessReportJs({ job, expectedArtifacts: expected });
    const viaPort = buildCompletenessReport({ job, expectedArtifacts: expected }, wasm(fakePort()));
    assert.deepEqual(viaPort, js);
    assert.equal(reportHash(viaPort), reportHash(js));
    assert.equal(canEnterReviewing(viaPort), canEnterReviewing(js));
  }
  assert.equal(canEnterReviewing(buildCompletenessReport({ job: passingJob(), expectedArtifacts: ['patch.diff'] }, wasm(fakePort()))), true);
});

test('every port fault or disagreement marks the report unverified and never lets it into reviewing', () => {
  const good = fakePort().loader().completenessReport;
  const cases = [
    [() => { throw new davParseWasm.DavParseError('x', 'ambiguous'); }, 'impl_refused'],
    [() => { throw new Error('trap'); }, 'impl_refused'],
    [() => undefined, 'impl_mismatch'],
    [() => ({}), 'impl_mismatch'],
    [(j, e) => ({ ...good(j, e), hash: '0'.repeat(64) }), 'impl_mismatch'],
    [(j, e) => { const r = good(j, e); return { ...r, report: { ...r.report, overall: 'unknown' } }; }, 'impl_mismatch'],
    [(j, e) => { const r = good(j, e); r.report.checks[0].detail += ' '; return r; }, 'impl_mismatch'],
    [(j, e) => { const r = good(j, e); r.report.checks[4].evidence.sha = SHA.toUpperCase(); return r; }, 'impl_mismatch'],
    [(j, e) => { const r = good(j, e); r.report.extra = true; return r; }, 'impl_mismatch'],
    [() => ({ unhashable: 'large', overall: 'pass', statuses: ['pass', 'pass', 'pass', 'pass', 'pass'] }), 'impl_mismatch'],
  ];
  for (const [i, [call, reason]] of cases.entries()) {
    const { value: report, seen } = quietly(() => buildCompletenessReport({ job: passingJob(), expectedArtifacts: ['patch.diff'] }, wasm(fakePort(call))));
    assert.equal(report.unverified, reason, `case ${i}`);
    assert.equal(report.overall, 'unknown', `case ${i}: a JS pass becomes unknown`);
    assert.equal(canEnterReviewing(report), false, `case ${i}`);
    assert.ok(seen.every((m) => !m.includes('job-pass') && !m.includes(SHA)), 'warnings carry no job text');
    // A JS fail stays fail.
    const { value: failed } = quietly(() => buildCompletenessReport({ job: failingJob() }, wasm(fakePort(call))));
    assert.equal(failed.overall, 'fail', `case ${i}`);
    assert.equal(canEnterReviewing(failed), false);
  }
});

test('a port fault is logged once per reason', () => {
  const port = fakePort(() => { throw new davParseWasm.DavParseError('x', 'trap-once-test'); });
  const { seen } = quietly(() => {
    for (let i = 0; i < 3; i++) buildCompletenessReport({ job: passingJob() }, wasm(port));
  });
  assert.deepEqual(seen, ['[completeness-report] completeness_report.wasm_fault (trap-once-test); the report is unverified']);
});

test('when the JS throws the port is not asked', () => {
  const port = fakePort();
  for (const input of [{ job: null }, { job: 'x' }, { job: { steps: 'x' } }, { job: { steps: [null] } }, { job: {}, expectedArtifacts: 5 }]) {
    assert.throws(() => buildCompletenessReport(input, wasm(port)));
  }
  assert.equal(port.calls.length, 0);
});

test('an unhashable report: the same refusal and statuses agree, a different one does not', () => {
  let job = { sha: SHA };
  for (let i = 0; i < 70; i++) job = { d: job };
  const deepJob = { ...passingJob(), checkpoint: { sha: SHA, deep: job } };
  const js = buildCompletenessReportJs({ job: deepJob, expectedArtifacts: ['patch.diff'] });
  assert.throws(() => reportHash(js), /nested too deeply/);
  const statuses = js.checks.map((c) => c.status);
  const agree = buildCompletenessReport({ job: deepJob, expectedArtifacts: ['patch.diff'] }, wasm(fakePort(() => ({ unhashable: 'deep', overall: js.overall, statuses }))));
  assert.deepEqual(agree, js);
  for (const reply of [{ unhashable: 'large', overall: js.overall, statuses }, { unhashable: 'deep', overall: 'fail', statuses },
    { unhashable: 'deep', overall: js.overall, statuses: [...statuses].reverse().map((s, i) => (i === 0 ? 'fail' : s)) }]) {
    const { value } = quietly(() => buildCompletenessReport({ job: deepJob, expectedArtifacts: ['patch.diff'] }, wasm(fakePort(() => reply))));
    assert.equal(value.unverified, 'impl_mismatch');
  }
});

test('the wire wrapper refuses what it cannot serialise and checks the reply shape', () => {
  const cyclic = { id: 'c' }; cyclic.self = cyclic;
  assert.throws(() => davParseWasm.completenessReport(cyclic, null), (e) => e.reason === 'input');
  assert.throws(() => davParseWasm.completenessReport({ big: 1n }, null), (e) => e.reason === 'input');
  const ok = { hash: 'a'.repeat(64), report: {} };
  assert.deepEqual(davParseWasm.completenessReply(ok), ok);
  assert.deepEqual(davParseWasm.completenessReply({ unhashable: 'deep', overall: 'pass', statuses: ['pass', 'pass', 'pass', 'pass', 'pass'] }).unhashable, 'deep');
  for (const bad of [null, {}, { hash: 'A'.repeat(64), report: {} }, { hash: 'a'.repeat(64), report: [] }, { ...ok, extra: 1 },
    { unhashable: 'circular', overall: 'pass', statuses: ['pass', 'pass', 'pass', 'pass', 'pass'] },
    { unhashable: 'deep', overall: 'ok', statuses: ['pass', 'pass', 'pass', 'pass', 'pass'] }, { unhashable: 'deep', overall: 'pass', statuses: ['pass'] }]) {
    assert.throws(() => davParseWasm.completenessReply(bad), (e) => e.reason === 'reply');
  }
});

// A code task driven to verifying with full evidence (as task-lifecycle-authority.test.cjs does).
function toVerifying(jobs, id, AUTHORITY) {
  const SHA1 = '1'.repeat(40);
  jobs.append(id, 'task.stage', { from: 'planned', to: 'planned', revision: 0 }, AUTHORITY);
  jobs.append(id, 'task.stage', { from: 'planned', to: 'implementing', revision: 0 }, AUTHORITY);
  jobs.append(id, 'task.revision', { n: 1, headSha: SHA1, planHash: 'f'.repeat(64) }, AUTHORITY);
  jobs.append(id, 'task.stage', { from: 'implementing', to: 'verifying', revision: 1 }, AUTHORITY);
  jobs.append(id, 'checkpoint.created', { branch: 'noevia/task-synthetic', task: 'synthetic', headSha: SHA1 });
  jobs.append(id, 'step.started', { id: 'tests', title: 'Run the operator test command' });
  jobs.append(id, 'step.completed', { id: 'tests' });
  jobs.append(id, 'artifact.created', { name: 'test-report', kind: 'test-report', passed: true, exitCode: 0, headSha: SHA1 });
}

test('jobs.cjs: an unusable module keeps a complete task out of reviewing (409, unverified); the real module lets it in', async () => {
  const { createJobs, claimLifecycleAuthority } = require('./jobs.cjs');
  const AUTHORITY = claimLifecycleAuthority();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-switch-'));
  const saved = { impl: process.env.COMPLETENESS_REPORT_IMPL, wasm: process.env.DAV_PARSE_WASM };
  const restore = () => { for (const [k, v] of [['COMPLETENESS_REPORT_IMPL', saved.impl], ['DAV_PARSE_WASM', saved.wasm]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } davParseWasm.reset(); };
  try {
    const jobs = createJobs({ dir, kinds: ['code'], maxJobs: 10 });
    const id = jobs.create({ kind: 'code', projectId: 'p-synthetic', capabilities: ['read', 'edit'] });
    await jobs.run(id, async () => {
      toVerifying(jobs, id, AUTHORITY);
      const move = { from: 'verifying', to: 'reviewing', revision: 1, expectedArtifacts: ['test-report'] };
      process.env.COMPLETENESS_REPORT_IMPL = 'js'; // retired: changes nothing
      process.env.DAV_PARSE_WASM = path.join(dir, 'missing.wasm');
      davParseWasm.reset();
      quietly(() => assert.throws(() => jobs.append(id, 'task.stage', move, AUTHORITY),
        (e) => e.status === 409 && /unverified: impl_refused/.test(e.message)));
      restore();
      assert.equal(jobs.get(id).lifecycle, 'verifying', 'nothing was written');
      const entered = jobs.append(id, 'task.stage', move, AUTHORITY);
      assert.match(entered.data.reportHash, /^[0-9a-f]{64}$/);
      return { ok: true };
    });
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
