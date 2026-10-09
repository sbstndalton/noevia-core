#!/usr/bin/env node
'use strict';
// Regenerates the shared fixtures for COMPLETENESS_REPORT_IMPL: completeness-report.cjs's
// buildCompletenessReport and reportHash. The same file is committed byte-for-byte in
// sbstndalton/noevia-rs (crates/completeness-report/tests/fixtures/completeness-report.v1.json);
// noevia-core CI compares them.
//   node tools/gen-completeness-report-fixtures.cjs > tests/fixtures/completeness-report.v1.json
//
// Every expectation is what the JS itself returns, evaluated on the job exactly as it crosses the
// wire (JSON.parse of `wire`). Nothing here depends on the Node/ICU version (#1115): the module uses
// no Unicode tables (its key sort is by code units, its SHA regex ASCII-only, JSON.stringify writes
// lone surrogates as escapes since Node 12), so non-ASCII and lone-surrogate text is in the report
// rows. All jobs are synthetic.
//
// Sections (the wire is the request after the op byte 1):
//   reports:  { wire, reply }   the exact port reply: {"hash":…,"report":<canonical JSON>}
//   deep:     { wire, reply }   reportHash refuses (nested too deeply): {"unhashable":"deep",…}
//   throws:   { wire, want: { refused: 'input' } }      the JS throws
//   strict:   { wire, want: { refused: 'ambiguous' } }  the JS answers; the port does not model it
//                                                       (no JS answer recorded)

const path = require('node:path');
const crypto = require('node:crypto');
const { buildCompletenessReportJs, reportHash } = require(path.join(__dirname, '..', 'server', 'completeness-report.cjs'));

// The canonical text reportHash hashes, re-derived the way the module defines it.
function canonical(value, depth = 0) {
  if (value && typeof value === 'object') {
    if (depth >= 64) throw Error('deep');
    return Array.isArray(value)
      ? `[${value.map((v) => canonical(v, depth + 1)).join(',')}]`
      : `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k], depth + 1)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function evaluate(job, expected) {
  const wire = JSON.stringify([job, expected ?? null]);
  const [j, e] = JSON.parse(wire);
  const report = buildCompletenessReportJs({ job: j, expectedArtifacts: e });
  return { wire, report };
}

function reportRow(job, expected) {
  const { wire, report } = evaluate(job, expected);
  const text = canonical(report);
  const hash = reportHash(report);
  if (crypto.createHash('sha256').update(text).digest('hex') !== hash) throw Error('canonical text drifted from reportHash');
  return { wire, reply: `{"hash":"${hash}","report":${text}}` };
}

function deepRow(job, expected) {
  const { wire, report } = evaluate(job, expected);
  let threw = null;
  try { reportHash(report); } catch (err) { threw = err; }
  if (!threw || !/nested too deeply/.test(threw.message)) throw Error('deep row: reportHash did not refuse');
  const statuses = report.checks.map((c) => `"${c.status}"`).join(',');
  return { wire, reply: `{"unhashable":"deep","overall":"${report.overall}","statuses":[${statuses}]}` };
}

function throwsRow(job, expected) {
  const wire = JSON.stringify([job, expected ?? null]);
  const [j, e] = JSON.parse(wire);
  let threw = false;
  try { buildCompletenessReportJs({ job: j, expectedArtifacts: e }); } catch { threw = true; }
  if (!threw) throw Error(`throws row does not throw: ${wire}`);
  return { wire, want: { refused: 'input' } };
}

function strictRow(job, expected) {
  const wire = JSON.stringify([job, expected ?? null]);
  const [j, e] = JSON.parse(wire);
  buildCompletenessReportJs({ job: j, expectedArtifacts: e }); // must not throw: the JS answers
  return { wire, want: { refused: 'ambiguous' } };
}

const SHA = 'a'.repeat(40);
const step = (id, status, extra = {}) => ({ id, title: `Step ${id}`, status, ...extra });

// Hand-picked jobs: every branch of every check.
const REPORTS = [
  [{}], [{ id: 'job-1' }], [{ id: 7 }], [{ id: false }], [{ id: null }], [{ id: { nested: [1, 2] } }], [[]], [[1, 2]],
  // tests-run
  [{ steps: [step('tests', 'completed')] }], [{ steps: [step('test', 'failed')] }], [{ steps: [step('run-tests', 'running')] }],
  [{ steps: [step('test-suite', 'completed'), step('tests', 'running')] }], [{ steps: [step('tests', 'running'), step('test', 'failed')] }],
  [{ steps: [step('Tests', 'completed'), step('tests ', 'completed'), step('lint', 'completed')] }],
  [{ artifacts: [{ kind: 'test-report', passed: true, name: 'r' }] }], [{ artifacts: [{ kind: 'test-report', passed: false }] }],
  [{ artifacts: [{ kind: 'test-report', passed: 'true' }, { kind: 'test-report' }, { kind: 'Test-Report', passed: true }] }],
  [{ steps: [step('tests', 'completed')], artifacts: [{ kind: 'test-report', passed: false }] }],
  [{ steps: [{ id: 'tests' }], artifacts: [null, 0, 'x', [], { kind: 'test-report', passed: true }] }],
  [{ steps: [1, 'tests', true, [], { status: 'completed' }] }],
  // tool.completed self-reports are never evidence
  [{ steps: [step('harness.config', 'completed')], artifacts: [{ name: 'out.txt', kind: 'file', exitCode: 0, failed: false }] }],
  // artifacts-present
  [{ artifacts: [{ name: 'a' }, { name: 'b' }] }, ['a', 'b']], [{ artifacts: [{ name: 'a' }] }, ['a', 'b', 'c']],
  [{ artifacts: [] }, []], [{}, ['x', 'x', 'y']], [{ artifacts: [{ name: 1 }, { name: null }, null, { name: 'ok' }] }, ['ok', '']],
  [{ artifacts: [{ name: 'é' }, { name: '😀' }, { name: '\ud800' }] }, ['é', '😀', '\ud800', 'é', '\udc00']],
  [{ artifacts: 0 }, ['a']], [{ artifacts: '' }], [{ artifacts: null }, null],
  // plan-steps-closed
  [{ plan: { status: 'skipped' } }], [{ plan: { status: 'skipped' }, steps: [step('a', 'running')] }], [{ plan: { status: 'proposed', question: 'q', subQuestions: ['a'] } }],
  [{ plan: { status: 'edited' }, steps: [step('a', 'completed'), step('b', 'completed')] }], [{ steps: [step('a', 'completed'), step('b', 'running'), step('c', 'failed')] }],
  [{ plan: 'yes', steps: [] }], [{ plan: 0, steps: [] }], [{ plan: ['skipped'], steps: [] }], [{ plan: { status: 'Skipped' } }],
  [{ steps: [{ id: 3, status: 4.5 }, { id: true, status: null }, { id: 'x' }, 'y', 12] }],
  [{ steps: [{ id: 1e21, status: 1e-7 }, { id: -0, status: 0.1 }, { id: 123456789012, status: 5e-324 }] }],
  [{ steps: 0 }], [{ steps: false, plan: { status: 'proposed' } }],
  // no-unresolved-uncertainty
  [{ uncertain: [{}] }], [{ uncertain: [{}, {}, {}] }], [{ pendingApproval: { tool: 'write', args: { path: 'x' } } }],
  [{ uncertain: [1], pendingApproval: 'yes' }], [{ uncertain: [], pendingApproval: 0 }], [{ uncertain: 0, pendingApproval: '' }],
  [{ pendingApproval: [] }], [{ pendingApproval: false }],
  // checkpoint-head-recorded
  [{ checkpoint: { branch: 'b', identityHash: 'h' } }], [{ checkpoint: { sha: SHA } }], [{ checkpoint: { headSha: 'ABCDEF0' } }],
  [{ checkpoint: { head_sha: 'abcdef' } }], [{ checkpoint: { commitSha: 'g'.repeat(40) } }], [{ checkpoint: { commit_sha: 'a'.repeat(41) } }],
  [{ checkpoint: { commit: `${SHA}\n` } }], [{ checkpoint: { sha: '', headSha: 5, head_sha: 'not a sha "quoted"\\' } }],
  [{ checkpoint: { sha: 'abc\u0000def' } }], [{ checkpoint: { commit: 'ａｂｃｄｅｆ０' } }], [{ checkpoint: { sha: '\ud800abcdef' } }],
  [{ checkpoint: { commit: SHA, sha: 'deadbee' } }], [{ checkpoint: 'abc' }], [{ checkpoint: 0 }], [{ checkpoint: [SHA] }], [{ checkpoint: true }],
  // a whole passing job
  [{ id: 'job-pass', kind: 'code', steps: [step('plan', 'completed'), step('tests', 'completed')], artifacts: [{ name: 'patch.diff' }],
    plan: { status: 'proposed', question: null, subQuestions: [] }, uncertain: [], pendingApproval: null, checkpoint: { branch: 'w', sha: SHA } }, ['patch.diff']],
  // forged claims stay inert
  [{ id: 'job-forged', testsPassed: true, review: 'approved', merged: true, result: { tests: 'pass' }, steps: [step('implement', 'completed')], plan: { status: 'proposed' },
    checkpoint: { sha: SHA }, artifacts: [{ kind: 'test-report', passed: 'yes' }] }],
  // key order and escapes
  [{ id: 'ordering', checkpoint: { z: 1, a: 2, B: 3, 10: 4, 2: 5, 'é': 6, '\ud800': 7, '': 8, '__proto__': 9, sha: SHA } }],
  [{ id: 'esc', checkpoint: { sha: 'x', note: '"\\\b\f\n\r\t\u0001\u001f\u007f  </script>' } }],
  [{ id: 'nums', plan: { a: [0, -1, 1.5, 1e21, 1e-7, 123e-20, 2 ** 53, -(2 ** 31), 0.1 + 0.2, 1 / 3] } }],
];

// Seeded, synthetic: a mix of every field shape the checks read.
function* seeded(n, seed) {
  let x = seed >>> 0;
  const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
  const IDS = ['tests', 'test', 'run-tests', 'test-suite', 'build', 'lint', 'plan', 'é', 'tests\u0000', 7];
  const STATUSES = ['completed', 'running', 'failed', 'skipped', 'Completed', null, 3];
  const NAMES = ['a', 'b', 'patch.diff', 'report.json', '😀', 'x y', ''];
  const SHAS = [SHA, 'abcdef0', 'ABCDEF1234', 'xyz', '', `${SHA}0`, 'deadbeefz'];
  for (let i = 0; i < n; i++) {
    const job = { id: `job-${i}` };
    if (rnd() < 0.85) job.steps = Array.from({ length: Math.floor(rnd() * 5) }, () => {
      const s = { id: pick(IDS), status: pick(STATUSES) };
      if (rnd() < 0.3) s.title = pick(NAMES);
      return s;
    });
    if (rnd() < 0.8) job.artifacts = Array.from({ length: Math.floor(rnd() * 4) }, () => (rnd() < 0.3
      ? { kind: 'test-report', passed: pick([true, false, 'true', null]), name: pick(NAMES) }
      : { name: pick(NAMES), kind: pick(['file', 'text']) }));
    if (rnd() < 0.6) job.plan = pick([{ status: 'proposed', question: 'q', subQuestions: [] }, { status: 'skipped', question: null, subQuestions: [] }, { status: 'edited' }, null]);
    if (rnd() < 0.6) job.uncertain = Array.from({ length: Math.floor(rnd() * 3) }, (_, k) => ({ tool: `t${k}` }));
    if (rnd() < 0.3) job.pendingApproval = pick([{ tool: 'write' }, null]);
    if (rnd() < 0.7) job.checkpoint = { branch: 'w', [pick(['sha', 'headSha', 'head_sha', 'commitSha', 'commit_sha', 'commit', 'other'])]: pick(SHAS) };
    const expected = rnd() < 0.5 ? null : Array.from({ length: Math.floor(rnd() * 3) }, () => pick(NAMES));
    yield [job, expected];
  }
}

// Passing jobs, each with at most one perturbation: the "pass" outcome and its nearest misses.
function* nearPass(n, seed) {
  let x = seed >>> 0;
  const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
  const MUTATIONS = [
    null, null, null,
    (j) => { j.steps.push({ id: 'tests', status: 'running' }); },
    (j) => { j.steps[0].status = 'failed'; },
    (j) => { j.artifacts.push({ kind: 'test-report', passed: false }); },
    (j) => { j.uncertain.push({ tool: 'shell' }); },
    (j) => { j.pendingApproval = { tool: 'write' }; },
    (j) => { j.checkpoint.sha = 'zzzzzzz'; },
    (j) => { delete j.checkpoint.sha; },
    (j) => { j.plan = { status: 'skipped', question: null, subQuestions: [] }; },
    (j) => { j.steps = j.steps.filter((s) => s.id !== 'tests'); },
    (j, e) => { e.push('missing.txt'); },
  ];
  for (let i = 0; i < n; i++) {
    const names = Array.from({ length: 1 + Math.floor(rnd() * 3) }, (_, k) => `out-${i}-${k}.txt`);
    const job = {
      id: `pass-${i}`, kind: pick(['code', 'research']),
      steps: [{ id: pick(['tests', 'test', 'run-tests', 'test-suite']), title: 'Run tests', status: 'completed' }, { id: 'implement', title: 'Implement', status: 'completed' }],
      artifacts: names.map((name) => ({ name, kind: 'file' })).concat(rnd() < 0.5 ? [{ kind: 'test-report', passed: true, name: 'tests.json' }] : []),
      plan: { status: pick(['proposed', 'edited']), question: null, subQuestions: [] },
      uncertain: [], pendingApproval: null,
      checkpoint: { branch: `w/${i}`, [pick(['sha', 'headSha', 'head_sha', 'commitSha', 'commit_sha', 'commit'])]: pick([SHA, 'abcdef0', 'ABCDEF0123456789']) },
    };
    const expected = rnd() < 0.8 ? names.slice(0, 1 + Math.floor(rnd() * names.length)) : null;
    const m = pick(MUTATIONS);
    if (m) m(job, expected || []);
    yield [job, expected];
  }
}

function nest(depth, leaf) {
  let v = leaf;
  for (let i = 0; i < depth; i++) v = { d: v };
  return v;
}

// Containers at the reportHash depth limit, in each place a job's own value is serialised.
const DEEP = [
  [{ checkpoint: nest(70, SHA) }], [{ checkpoint: { branch: nest(60, 1), sha: SHA } }], [{ plan: nest(61, 'x') }],
  [{ id: nest(64, 'x') }], [{ steps: [step('tests', 'completed', { more: nest(60, 1) })] }],
  [{ artifacts: [{ kind: 'test-report', passed: true, more: nest(60, 1) }] }],
];
// Just under the limit: still hashable.
const SHALLOW = [[{ checkpoint: { branch: nest(59, 1), sha: SHA } }], [{ id: nest(63, 'x') }], [{ plan: nest(60, 'x') }]];

const THROWS = [
  [{ steps: 'tests' }], [{ steps: { 0: step('tests', 'completed') } }], [{ steps: 1 }], [{ steps: [null] }], [{ steps: [step('a', 'completed'), null] }],
  [{ artifacts: 'x' }], [{ artifacts: { name: 'a' } }], [{}, 5], [{}, true], [{}, { 0: 'a' }],
];

const STRICT = [
  [{ uncertain: 'abc' }], [{ uncertain: { length: 2 } }], [{ uncertain: 5 }], [{}, 'ab'], [{}, ['a', 1]], [{}, [null]], [{}, [['a']]],
  [{ steps: [{ id: { a: 1 }, status: 'running' }] }], [{ steps: [{ id: 'x', status: ['failed'] }] }],
];

function out() {
  const reports = [...REPORTS, ...SHALLOW, ...seeded(200, 0x5eed1), ...nearPass(150, 0x9a55)].map(([j, e]) => reportRow(j, e));
  return {
    version: 1,
    reports,
    deep: DEEP.map(([j, e]) => deepRow(j, e)),
    throws: THROWS.map(([j, e]) => throwsRow(j, e)),
    strict: STRICT.map(([j, e]) => strictRow(j, e)),
  };
}

process.stdout.write(`${JSON.stringify(out())}\n`);
