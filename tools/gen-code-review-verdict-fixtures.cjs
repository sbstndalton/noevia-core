#!/usr/bin/env node
'use strict';
// Regenerates the shared fixtures for CODE_REVIEW_VERDICT_IMPL: code-review-verdict.cjs readVerdict
// and boundReviewEvent (#519). The same file is committed byte-for-byte in sbstndalton/noevia-rs
// (crates/review-verdict/tests/fixtures/code-review-verdict.v1.json); noevia-core CI compares them.
//   node tools/gen-code-review-verdict-fixtures.cjs > tests/fixtures/code-review-verdict.v1.json
//
// Every expectation is what the JS itself returns. All text is synthetic. Values are written in
// review-verdict's tagged form (dav-parse-wasm.cjs reviewTag: what crosses to the module), so
// undefined, -0 and NaN survive JSON.
//
// Sections:
//   read:  { raw: T, want: { ok: T } | { error: message }, stricter? }   readVerdict(raw)
//   bound: { type: T, data: T, want: T, stricter? }                       boundReviewEvent(type, data)
// `stricter: true` marks a row whose input holds ['x'] (an object the port is not shown): there the
// port may refuse ('opaque'), which the host turns into the JS's own failure path.
//
// The JS references (retired from production in #1071, so they live with the tests):
//   tests/server/oracle/code-review-verdict.cjs

const path = require('node:path');
const server = path.join(__dirname, '..', 'server');
const { readVerdictJs, boundReviewEventJs } = require(path.join(__dirname, '..', 'tests', 'server', 'oracle', 'code-review-verdict.cjs'));
const { reviewTag } = require(path.join(server, 'dav-parse-wasm.cjs'));

const hasOpaque = (t) => Array.isArray(t) && (t[0] === 'x' || t.some(hasOpaque));
class Instance { constructor(o) { Object.assign(this, o); } }

const SUMMARIES = ['Looks fine.', '  padded  ', '', '   ', '\u0000\u001b[31mred\u001b[0m', '‮evil‬', '⁦iso⁩', 'a\tb\nc\rd',
  '﻿ ok 　', '\u0085x', '​', 'a'.repeat(600), 'a'.repeat(601), '😀'.repeat(601), `${'a'.repeat(599)}😀😀`, `${'a'.repeat(599)}\ud83d`,
  '\ud800lone', 'lone\udfff', '\u007f\u0008\u000b\u000c\u001f\u0009\u000a', 5, null, undefined, {}, ['s'], true];

const F = (o) => o;
const FINDING_ITEMS = [
  F({ severity: 'blocker', message: 'Breaks the build.' }), F({ severity: 'major', file: 'src/a.js', message: 'Off by one.' }),
  F({ severity: 'minor', file: '', message: 'Empty file.' }), F({ severity: 'note', file: '   ', message: 'Blank file.' }),
  F({ severity: 'note', file: null, message: 'Null file.' }), F({ severity: 'note', file: 5, message: 'Number file.' }),
  F({ severity: 'note', file: 'f'.repeat(300), message: 'Long file.' }), F({ severity: 'note', file: undefined, message: 'Undefined file.' }),
  F({ severity: 'note', file: '‮dir/\u0000x', message: ' \u0007 ' }), F({ severity: 'note', message: '' }), F({ severity: 'note' }),
  F({ severity: 'note', message: 'm'.repeat(700) }), F({ severity: 'Blocker', message: 'case' }), F({ message: 'no severity' }),
  F({ severity: 'note', message: 'grant', grant: true }), F({ severity: 'note', message: 5 }), F({ severity: 'note', message: { text: 'x' } }),
  null, [], 'note', 7, undefined, () => 1, new Instance({ severity: 'note', message: 'class' }),
];

function readCases() {
  const cases = [];
  const base = { verdict: 'request_changes', summary: 'Needs work.', findings: [{ severity: 'minor', message: 'Rename x.' }] };
  for (const verdict of ['approve', 'request_changes', 'APPROVE', 'reject', '', null, undefined, 1, ['approve'], {}]) {
    for (const findings of [[], [FINDING_ITEMS[0]], [FINDING_ITEMS[1]], [FINDING_ITEMS[3]]]) cases.push({ verdict, summary: 'S.', findings });
  }
  for (const summary of SUMMARIES) for (const verdict of ['approve', 'request_changes']) cases.push({ verdict, summary, findings: [FINDING_ITEMS[1]] });
  for (const item of FINDING_ITEMS) for (const verdict of ['approve', 'request_changes']) cases.push({ verdict, summary: 'S.', findings: [item] });
  for (const item of FINDING_ITEMS) cases.push({ ...base, findings: [FINDING_ITEMS[1], item, FINDING_ITEMS[2]] });
  for (const n of [0, 1, 11, 12, 13, 40]) {
    for (const verdict of ['approve', 'request_changes']) cases.push({ verdict, summary: 'S.', findings: Array.from({ length: n }, (_, i) => ({ severity: i % 2 ? 'note' : 'minor', message: `m${i}` })) });
  }
  // Both checks fail: the JS's order decides which message.
  cases.push({ verdict: 'nope', summary: 5, findings: 'x' }, { verdict: 'approve', summary: 5, findings: Array(13).fill(FINDING_ITEMS[0]) },
    { verdict: 'approve', summary: '', findings: [FINDING_ITEMS[0]] }, { verdict: 'request_changes', summary: '', findings: [] },
    { verdict: 'approve', summary: 'S.', findings: Array(13).fill(null) }, { verdict: 'approve', summary: 'S.', findings: [FINDING_ITEMS[9], FINDING_ITEMS[13]] });
  for (const findings of [{}, null, undefined, 'x', 3, { length: 0 }]) cases.push({ verdict: 'approve', summary: 'S.', findings });
  // Fields a review cannot have, and shapes that are not a plain verdict.
  cases.push({ ...base, approvalId: 'a1' }, { ...base, grant: undefined }, { verdict: 'approve', summary: 'S.' }, {},
    JSON.parse('{"__proto__":1,"verdict":"approve","summary":"S.","findings":[]}'),
    Object.assign(Object.create(null), { verdict: 'approve', summary: 'S.', findings: [] }),
    null, undefined, 'approve', 1, [], [base], () => base, new Instance(base), Object.create(base),
    { verdict: 'approve', summary: 'S.', findings: [, FINDING_ITEMS[1]] }); // eslint-disable-line no-sparse-arrays
  return cases;
}

function bindCases() {
  const rows = [];
  const types = ['review.requested', 'review.failed', 'review.completed', 'review.other', '', undefined, 5, null];
  const shas = ['abcdef0', 'a'.repeat(64), 'abcdef', 'a'.repeat(65), 'ABCDEF0', 'abcdefg', 'abcdef0\n', ' abcdef0', 1234567, null, undefined, ['abcdef0']];
  const counts = [0, -0, 5, 5.5, -1, 1e300, 100000, 100001, NaN, Infinity, -Infinity, '5', null, undefined, true];
  const texts = ['x', '', '  ', 'a'.repeat(50), 'r'.repeat(301), '\u0000‮', ' trimmed ', 5, null, undefined, '😀'.repeat(41)];
  const verdicts = [
    { verdict: 'approve', summary: 'Fine.', findings: [] },
    { verdict: 'request_changes', summary: ' Fix. ', findings: [{ severity: 'major', file: 'a.js', message: 'm' }] },
    { verdict: 'request_changes', summary: 'Fix.', findings: [] },
    { verdict: 'approve', summary: 'Fine.', findings: [{ severity: 'blocker', message: 'b' }] },
    { verdict: 'approve', summary: 'Fine.', findings: [new Instance({ severity: 'note', message: 'x' })] },
    { verdict: undefined },
    { summary: 'Fine.', findings: [] },
  ];
  for (const type of types) {
    for (const data of [undefined, null, 'x', [], {}, new Instance({ baseSha: 'abcdef0' })]) rows.push([type, data]);
    rows.push([type, { baseSha: 'abcdef0', headSha: 'b'.repeat(40), files: 3, code: 'timeout', reason: 'Too slow.', ...verdicts[1], corrected: true }]);
  }
  for (const type of ['review.requested', 'review.failed', 'review.completed']) {
    for (const s of shas) rows.push([type, { baseSha: s, headSha: s, ...verdicts[0] }]);
  }
  for (const files of counts) rows.push(['review.requested', { files }]);
  for (const code of texts) for (const reason of [texts[0], texts[1], texts[4], texts[5], texts[7]]) rows.push(['review.failed', { code, reason }]);
  for (const reason of texts) rows.push(['review.failed', { code: 'c', reason }]);
  for (const v of verdicts) for (const corrected of [true, 'true', 1, false, undefined]) rows.push(['review.completed', { ...v, corrected }]);
  for (const c of readCases().slice(0, 120)) rows.push(['review.completed', c && typeof c === 'object' && !Array.isArray(c) ? { ...c, extra: 'kept out' } : c]);
  return rows;
}

function read() {
  return readCases().map((raw) => {
    const t = reviewTag(raw);
    let want;
    try { want = { ok: reviewTag(readVerdictJs(raw)) }; } catch (e) {
      if (e.name !== 'ReviewVerdictError') throw e;
      want = { error: e.message };
    }
    return { raw: t, want, ...(hasOpaque(t) ? { stricter: true } : {}) };
  });
}

function bound() {
  return bindCases().map(([type, data]) => {
    const tt = reviewTag(type);
    // The host applies the `= {}` default before anything crosses.
    const td = reviewTag(data === undefined ? {} : data);
    const want = reviewTag(boundReviewEventJs(type, data));
    return { type: tt, data: td, want, ...(hasOpaque(td) ? { stricter: true } : {}) };
  });
}

process.stdout.write(`${JSON.stringify({ version: 1, read: read(), bound: bound() })}\n`);
