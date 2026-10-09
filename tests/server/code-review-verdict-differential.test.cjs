'use strict';

// Review verdict (CODE_REVIEW_VERDICT_IMPL, retired in #1071): tests/fixtures/code-review-verdict.v1.json (byte-identical to noevia-rs
// crates/review-verdict/tests/fixtures/; CI compares them) holds what code-review-verdict.cjs
// readVerdict and boundReviewEvent return, printed by tools/gen-code-review-verdict-fixtures.cjs
// from the JS references (tests/server/oracle/code-review-verdict.cjs; synthetic text only). Here every row runs through dav-parse.wasm's
// review_verdict and must agree exactly (-0 included); a row marked `stricter` may instead take the
// JS's own failure path. Then seeded live JS-vs-wasm verdicts and events, the retired switch, the reply
// checks and the fail-closed paths. The WebAssembly half needs server/wasm/dav-parse.wasm (or
// DAV_PARSE_WASM); skipped without it unless DAV_PARSE_WASM_REQUIRED=1.

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const davParseWasm = require('../../server/dav-parse-wasm.cjs');
const verdict = require('../../server/code-review-verdict.cjs');
const oracle = require('./oracle/code-review-verdict.cjs');

const FILE = path.join(__dirname, '../fixtures/code-review-verdict.v1.json');
const GENERATOR = path.join(__dirname, '../../tools/gen-code-review-verdict-fixtures.cjs');
const fixtures = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const wasmFile = process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM;
const skipWasm = !fs.existsSync(wasmFile) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built';

class Opaque {}
/** The JS value a tagged fixture value stands for (['x'] as a class instance). */
function untag(t) {
  if (!Array.isArray(t)) return t;
  switch (t[0]) {
    case 'u': return undefined;
    case 'f': return () => {};
    case 'x': return new Opaque();
    case 'n': return { '-0': -0, NaN, Infinity, '-Infinity': -Infinity }[t[1]];
    case 'a': return t[1].map(untag);
    case 'o': return Object.fromEntries(t[1].map(([k, v]) => [k, untag(v)]));
    default: throw new Error(`bad tag ${t[0]}`);
  }
}
const outcome = (fn) => { try { return { ok: fn() }; } catch (e) { if (e.name !== 'ReviewVerdictError') throw e; return { error: e.message }; } };

async function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test('the fixture file is what the generator prints', { skip: !fs.existsSync(GENERATOR) && 'no generator here' }, () => {
  const out = execFileSync(process.execPath, [GENERATOR], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env } });
  assert.equal(out, fs.readFileSync(FILE, 'utf8'));
});

test('the reasons the port names are the JS messages', () => {
  const thrown = new Set(fixtures.read.filter((r) => r.want.error).map((r) => r.want.error));
  assert.deepEqual([...thrown].sort(), Object.values(verdict.MESSAGES).sort());
});

test('read rows: the same verdict or the same ReviewVerdictError through the Rust port', { skip: skipWasm }, () => {
  let stricter = 0;
  fixtures.read.forEach((row, i) => {
    const raw = untag(row.raw);
    const want = row.want.ok ? { ok: untag(row.want.ok) } : { error: row.want.error };
    // (An opaque value's contents are not in the fixture, so only full rows replay in the JS.)
    if (!row.stricter) assert.deepStrictEqual(outcome(() => oracle.readVerdictJs(raw)), want, `row ${i} (js)`);
    const got = outcome(() => verdict.readVerdict(raw));
    if (row.stricter && got.error === verdict.FAULT_MESSAGE) {
      // An object the port is not shown: it refuses, which is ReviewVerdictError (never a verdict).
      assert.equal(got.error, verdict.FAULT_MESSAGE, `row ${i} (stricter)`);
      stricter++;
      return;
    }
    assert.deepStrictEqual(got, want, `row ${i}`);
  });
  assert.ok(stricter > 0);
});

test('bound rows: the same event through the Rust port, -0 included', { skip: skipWasm }, () => {
  fixtures.bound.forEach((row, i) => {
    const type = untag(row.type), data = untag(row.data), want = untag(row.want);
    if (!row.stricter) assert.deepStrictEqual(oracle.boundReviewEventJs(type, data), want, `row ${i} (js)`);
    const got = verdict.boundReviewEvent(type, data);
    if (row.stricter && got.status === 'failed' && got.code === 'invalid') {
      assert.equal(got.code, 'invalid', `row ${i} (stricter)`);
      return;
    }
    assert.deepStrictEqual(got, want, `row ${i}`);
    if (Object.is(want.files, -0)) assert.ok(Object.is(got.files, -0), `row ${i}: -0`);
  });
  // The default for a missing data argument.
  assert.deepStrictEqual(verdict.boundReviewEvent('review.requested'), oracle.boundReviewEventJs('review.requested'));
});

test('seeded live verdicts and events agree', { skip: skipWasm }, () => {
  let seed = 519;
  const rnd = (m) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed % m; };
  const pick = (xs) => xs[rnd(xs.length)];
  const CHARS = ['a', 'Z', ' ', '\t', '\n', '\u0000', '\u001b', '\u007f', '‮', '⁨', '﻿', '　', '\u0085', '😀', '\ud800', '\udc00', 'é'];
  const str = (n = 12) => Array.from({ length: rnd(n) }, () => pick(CHARS)).join('');
  const long = () => (rnd(4) ? str() : pick(CHARS).repeat(590 + rnd(20)) + str(4));
  const scalar = () => pick([() => undefined, () => null, () => rnd(2) === 0, () => pick([0, -0, 5, 2.5, -1, 1e300, NaN, 100001]), str, long,
    () => pick(['approve', 'request_changes', 'blocker', 'major', 'minor', 'note', 'abcdef0', 'f'.repeat(40)])])();
  const finding = () => {
    if (!rnd(8)) return scalar();
    const f = {};
    if (rnd(8)) f.severity = rnd(6) ? pick(['blocker', 'major', 'minor', 'note']) : scalar();
    if (rnd(2)) f.file = rnd(3) ? str(300) : scalar();
    if (rnd(8)) f.message = rnd(4) ? long() : scalar();
    if (!rnd(12)) f[pick(['grant', 'allow', 'approvalId'])] = scalar();
    return f;
  };
  const raw = () => {
    if (!rnd(15)) return scalar();
    const r = {};
    if (rnd(10)) r.verdict = rnd(5) ? pick(['approve', 'request_changes']) : scalar();
    if (rnd(10)) r.summary = rnd(4) ? long() : scalar();
    if (rnd(10)) r.findings = rnd(8) ? Array.from({ length: rnd(15) }, finding) : scalar();
    if (!rnd(12)) r.extra = scalar();
    return r;
  };
  for (let i = 0; i < 3000; i++) {
    const r = raw();
    assert.deepStrictEqual(outcome(() => verdict.readVerdict(r)), outcome(() => oracle.readVerdictJs(r)), `read ${i}: ${JSON.stringify(r)}`);
    const data = rnd(10) ? { ...(r && typeof r === 'object' ? r : {}), baseSha: scalar(), headSha: pick(['abcdef0', 'ABCDEF0', str()]), files: scalar(), code: scalar(), reason: scalar(), corrected: scalar() } : scalar();
    const type = pick(['review.requested', 'review.failed', 'review.completed', 'review.x', 5]);
    const want = oracle.boundReviewEventJs(type, data), got = verdict.boundReviewEvent(type, data);
    assert.deepStrictEqual(got, want, `bound ${i}`);
    assert.equal(Object.is(got.files, -0), Object.is(want.files, -0), `bound ${i}: -0`);
  }
});

test('CODE_REVIEW_VERDICT_IMPL is retired: no switch, no JS twin in production, an object the port is not shown fails closed', { skip: skipWasm }, async () => {
  for (const gone of ['codeReviewVerdictImpl', 'readVerdictJs', 'boundReviewEventJs', 'readVerdictWasm', 'boundReviewEventWasm']) assert.equal(verdict[gone], undefined, gone);
  assert.ok(!davParseWasm.IMPL_FLAGS.includes('CODE_REVIEW_VERDICT_IMPL'));
  assert.equal(davParseWasm.RETIRED_FLAGS.CODE_REVIEW_VERDICT_IMPL, 'wasm');
  // An old =js changes nothing: the public functions go through the port.
  await withEnv({ CODE_REVIEW_VERDICT_IMPL: 'js' }, () => {
    const inst = new Opaque();
    Object.assign(inst, { verdict: 'approve', summary: 'S.', findings: [] });
    assert.deepStrictEqual(oracle.readVerdictJs(inst), { verdict: 'approve', summary: 'S.', findings: [] });
    assert.throws(() => verdict.readVerdict(inst), { name: 'ReviewVerdictError', message: verdict.FAULT_MESSAGE });
    assert.deepStrictEqual(verdict.readVerdict({ verdict: 'approve', summary: ' S. ', findings: [] }), { verdict: 'approve', summary: 'S.', findings: [] });
    assert.equal(verdict.boundReviewEvent('review.requested', { files: 2 }).files, 2);
  });
});

test('reply checks refuse anything a live verdict could not be', () => {
  const ok = { verdict: 'request_changes', summary: 'S.', findings: [{ severity: 'note', message: 'm' }] };
  assert.deepStrictEqual(davParseWasm.reviewVerdictReply(ok), ok);
  for (const bad of [
    { ...ok, grant: true },
    { ...ok, verdict: 'allow' },
    { ...ok, summary: '' },
    { ...ok, summary: 'a'.repeat(601) },
    { ...ok, findings: [] },
    { ...ok, verdict: 'approve', findings: [{ severity: 'blocker', message: 'b' }] },
    { ...ok, findings: [{ severity: 'note', message: 'm', approvalId: 'x' }] },
    { ...ok, findings: [{ severity: 'note', file: '', message: 'm' }] },
    { ...ok, findings: Array(13).fill({ severity: 'note', message: 'm' }) },
  ]) assert.throws(() => davParseWasm.reviewVerdictReply(bad), { reason: 'reply' });
});

test('fail closed: a missing module throws ReviewVerdictError and keeps a failed review', async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    await withEnv({ DAV_PARSE_WASM: path.join(__dirname, 'no-such-dav-parse.wasm'), CODE_REVIEW_VERDICT_IMPL: 'js' }, () => {
      davParseWasm.reset();
      assert.throws(() => verdict.readVerdict({ verdict: 'approve', summary: 'S.', findings: [] }), { name: 'ReviewVerdictError', message: verdict.FAULT_MESSAGE });
      assert.deepStrictEqual(verdict.boundReviewEvent('review.completed', { verdict: 'approve', summary: 'S.', findings: [], baseSha: 'abcdef0' }),
        { status: 'failed', reviewer: 'planner', baseSha: null, headSha: null, code: 'invalid', reason: 'The recorded verdict could not be read.' });
      assert.throws(() => davParseWasm.verifyAtStartup({ DAV_PARSE_WASM: process.env.DAV_PARSE_WASM }, { hostname: () => 'ss.io' }), /dav-parse\.wasm \(always required\) failed verification \(missing\)/);
    });
  } finally { console.warn = warn; davParseWasm.reset(); }
});

test('the tagged form keeps what JSON would lose and hides what the port must not guess at', () => {
  assert.deepStrictEqual(davParseWasm.reviewTag({ a: undefined, b: -0, c: NaN, d: () => 1, e: [1, [2, [3]]] }),
    ['o', [['a', ['u']], ['b', ['n', '-0']], ['c', ['n', 'NaN']], ['d', ['f']], ['e', ['a', [1, ['a', [2, ['x']]]]]]]]);
  assert.deepStrictEqual(davParseWasm.reviewTag([, 1]), ['x']); // eslint-disable-line no-sparse-arrays
  assert.deepStrictEqual(davParseWasm.reviewTag(new Opaque()), ['x']);
  assert.deepStrictEqual(davParseWasm.reviewTag(Object.create(null)), ['o', []]);
  assert.throws(() => davParseWasm.reviewVerdictRead({ summary: 'x'.repeat(5 * 1024 * 1024) }), { reason: 'too_large' });
});
