'use strict';

// Completeness report (COMPLETENESS_REPORT_IMPL, retired in #1071: the port always confirms the JS): tests/fixtures/completeness-report.v1.json (byte-identical to noevia-rs
// crates/completeness-report/tests/fixtures/; CI compares them) holds completeness-report.cjs's
// reports as the exact replies the Rust port must give (canonical report JSON and its sha256),
// printed by tools/gen-completeness-report-fixtures.cjs from the JS itself (synthetic jobs). Here
// every row runs through dav-parse.wasm's completeness_report and through the switched
// buildCompletenessReport; then seeded live jobs built in memory (as jobs.cjs derive() leaves them,
// undefined fields included): the switch hands out the JS report verified, and never anything the
// JS would not. The WebAssembly half needs server/wasm/dav-parse.wasm (or DAV_PARSE_WASM); skipped
// without it unless DAV_PARSE_WASM_REQUIRED=1.

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const davParseWasm = require('../../server/dav-parse-wasm.cjs');
const cr = require('../../server/completeness-report.cjs');

const FILE = path.join(__dirname, '../fixtures/completeness-report.v1.json');
const GENERATOR = path.join(__dirname, '../../tools/gen-completeness-report-fixtures.cjs');
const fixtures = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const wasmFile = process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM;
const skipWasm = !fs.existsSync(wasmFile) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built';

// Key-sorted JSON (the canonical text reportHash hashes, for values within its limits).
function canonical(v) {
  if (v && typeof v === 'object') {
    return Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
      : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** The port's answer as the wire reply text (what the fixture records). */
function portReply(job, expected) {
  const r = davParseWasm.completenessReport(job, expected);
  if (r.unhashable) return `{"unhashable":"${r.unhashable}","overall":"${r.overall}","statuses":${JSON.stringify(r.statuses)}}`;
  return `{"hash":"${r.hash}","report":${canonical(r.report)}}`;
}

const parts = (row) => JSON.parse(row.wire);

test('the fixture file is what the generator prints', { skip: !fs.existsSync(GENERATOR) && 'no generator here' }, () => {
  const out = execFileSync(process.execPath, [GENERATOR], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(out, fs.readFileSync(FILE, 'utf8'));
});

test('report and deep rows: the exact reply through the port; the switch hands out the JS report', { skip: skipWasm }, () => {
  assert.ok(fixtures.reports.length >= 400 && fixtures.deep.length >= 5);
  const seen = { pass: 0, fail: 0, unknown: 0 };
  for (const key of ['reports', 'deep']) {
    for (const [i, row] of fixtures[key].entries()) {
      const [job, expected] = parts(row);
      assert.equal(portReply(job, expected), row.reply, `${key} row ${i}`);
      const js = cr.buildCompletenessReportJs({ job, expectedArtifacts: expected });
      const switched = cr.buildCompletenessReport({ job, expectedArtifacts: expected });
      assert.deepEqual(switched, js, `${key} row ${i}: verified, unchanged`);
      assert.equal(cr.canEnterReviewing(switched), js.overall === 'pass');
      seen[js.overall]++;
    }
  }
  assert.ok(seen.pass >= 40 && seen.fail >= 40 && seen.unknown >= 40, JSON.stringify(seen));
});

test('throws rows are refused as input (the JS throws, so the port is never asked); strict rows as ambiguous, and the switch marks them unverified', { skip: skipWasm }, () => {
  for (const [i, row] of fixtures.throws.entries()) {
    const [job, expected] = parts(row);
    assert.throws(() => davParseWasm.completenessReport(job, expected), (e) => e.reason === 'input', `throws row ${i}`);
    assert.throws(() => cr.buildCompletenessReport({ job, expectedArtifacts: expected }), `throws row ${i}: the JS throws`);
  }
  const warn = console.warn; console.warn = () => {};
  try {
    for (const [i, row] of fixtures.strict.entries()) {
      const [job, expected] = parts(row);
      assert.throws(() => davParseWasm.completenessReport(job, expected), (e) => e.reason === 'ambiguous', `strict row ${i}`);
      const js = cr.buildCompletenessReportJs({ job, expectedArtifacts: expected });
      const switched = cr.buildCompletenessReport({ job, expectedArtifacts: expected });
      assert.equal(switched.unverified, 'impl_refused', `strict row ${i}`);
      assert.equal(switched.overall, js.overall === 'fail' ? 'fail' : 'unknown');
      assert.equal(cr.canEnterReviewing(switched), false);
    }
  } finally { console.warn = warn; }
});

// Seeded jobs built in memory the way jobs.cjs derive() leaves them: `title: undefined` on steps
// without one, non-ASCII and astral names, lone surrogates, numbers in plan and checkpoint fields.
function* liveJobs(n, seed) {
  let x = seed >>> 0;
  const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
  const TEXT = ['tests', 'test', 'run-tests', 'test-suite', 'Grüße', 'ǅ', 'ﬃ', 'İ', '😀', '\ud800', 'a\u0000b', 'x'.repeat(50), ''];
  const NUM = [0, -0, 1, -1.5, 1e21, 1e-7, 0.1 + 0.2, 2 ** 53 + 2, 5e-324, 123456.789];
  const SHAS = ['c'.repeat(40), 'ABCDEF0', 'abc', 'ａｂｃｄｅｆ０', 'deadbeefK', ''];
  for (let i = 0; i < n; i++) {
    const steps = Array.from({ length: Math.floor(rnd() * 6) }, () => ({ id: pick(TEXT), title: rnd() < 0.5 ? undefined : pick(TEXT), status: pick(['completed', 'running', 'failed', 'completed']) }));
    const artifacts = Array.from({ length: Math.floor(rnd() * 4) }, () => (rnd() < 0.3
      ? { kind: 'test-report', passed: pick([true, false, true]), name: pick(TEXT), at: pick(NUM) }
      : { name: pick(TEXT), kind: 'file', size: pick(NUM) }));
    const job = {
      id: `live-${i}`, kind: 'code', steps, artifacts,
      plan: rnd() < 0.7 ? { status: pick(['proposed', 'edited', 'skipped']), question: pick([null, pick(TEXT)]), subQuestions: [pick(TEXT)], score: pick(NUM) } : null,
      uncertain: Array.from({ length: rnd() < 0.7 ? 0 : 1 + Math.floor(rnd() * 2) }, () => ({ tool: pick(TEXT) })),
      pendingApproval: rnd() < 0.15 ? { tool: 'write', path: pick(TEXT) } : null,
      checkpoint: rnd() < 0.85 ? { branch: pick(TEXT), [pick(['sha', 'headSha', 'head_sha', 'commitSha', 'commit_sha', 'commit'])]: pick(SHAS), n: pick(NUM) } : undefined,
    };
    if (rnd() < 0.35) { // a complete job, with whatever names and numbers it carries
      for (const st of steps) st.status = 'completed';
      steps.push({ id: pick(['tests', 'test', 'run-tests', 'test-suite']), title: undefined, status: 'completed' });
      for (const a of artifacts) if (a.kind === 'test-report') a.passed = true;
      Object.assign(job, { uncertain: [], pendingApproval: null, checkpoint: { branch: pick(TEXT), commit: pick(['c'.repeat(40), 'ABCDEF0']), n: pick(NUM) } });
      if (job.plan?.status === 'skipped') job.plan.status = 'edited';
    }
    const expected = rnd() < 0.3 ? undefined : artifacts.map((a) => a.name).filter((n) => typeof n === 'string' && rnd() < 0.8).concat(rnd() < 0.2 ? [pick(TEXT)] : []);
    yield [job, expected];
  }
}

test('seeded live jobs: the port agrees with this runtime\'s JS on every one (no false refusals)', { skip: skipWasm }, () => {
  let pass = 0, refusals = 0;
  for (const [job, expected] of liveJobs(800, 0xc0ffee)) {
    const js = cr.buildCompletenessReportJs({ job, expectedArtifacts: expected });
    const switched = cr.buildCompletenessReport({ job, expectedArtifacts: expected });
    if (switched.unverified) refusals++;
    else assert.deepEqual(switched, js);
    if (cr.canEnterReviewing(switched)) { assert.equal(js.overall, 'pass'); pass++; }
  }
  assert.equal(refusals, 0, 'every live job is verified');
  assert.ok(pass >= 20, `passing jobs: ${pass}`);
});

test('a report too large to hash: the port gives the same refusal and statuses', { skip: skipWasm }, () => {
  const job = { id: 'big', steps: [{ id: 'tests', status: 'failed', title: 'x'.repeat(1_500_000) }] };
  const js = cr.buildCompletenessReportJs({ job });
  assert.throws(() => cr.reportHash(js), /too large/);
  assert.deepEqual(davParseWasm.completenessReport(job, null), { unhashable: 'large', overall: 'fail', statuses: js.checks.map((c) => c.status) });
  assert.deepEqual(cr.buildCompletenessReport({ job }), js);
});

test('in-memory values JSON cannot carry never make the switch more permissive', { skip: skipWasm }, () => {
  const SHA = 'd'.repeat(40);
  const base = () => ({ id: 'odd', steps: [{ id: 'tests', status: 'completed' }], plan: { status: 'proposed' }, uncertain: [], checkpoint: { sha: SHA } });
  const warn = console.warn; console.warn = () => {};
  try {
    for (const job of [
      { ...base(), pendingApproval: Infinity }, // JS: pending (truthy); on the wire: null
      { ...base(), checkpoint: { sha: SHA, at: new Date(0) } }, // canonical {} vs toJSON string
      { ...base(), checkpoint: { sha: SHA, fn() {} } }, // canonical "null" vs dropped
      { ...base(), steps: [{ id: NaN, status: 'running' }] }, // "NaN" vs null
    ]) {
      const js = cr.buildCompletenessReportJs({ job });
      const switched = cr.buildCompletenessReport({ job });
      if (switched.unverified === undefined) assert.deepEqual(switched, js);
      if (cr.canEnterReviewing(switched)) assert.equal(js.overall, 'pass');
      if (js.overall === 'fail') assert.equal(switched.overall, 'fail');
    }
  } finally { console.warn = warn; }
});
