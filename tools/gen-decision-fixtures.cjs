#!/usr/bin/env node
'use strict';
// Regenerates the shared fixtures for DECISION_IMPL: decision/index.cjs's invalidRequest,
// invalidResult and causeOf. The same file is committed byte-for-byte in sbstndalton/noevia-rs
// (crates/decision/tests/fixtures/decision.v1.json); noevia-core CI compares them.
//   node tools/gen-decision-fixtures.cjs > tests/fixtures/decision.v1.json
//
// Every expectation is what the JS itself returns (invalidRequestJs, invalidResultJs, causeOfJs),
// or { throws: true } where it throws. `wire` is the JSON body that crosses, built by
// dav-parse-wasm.cjs's own projection (decisionRequestTag, decisionResultTag, decisionErrorFacts).
// All values are synthetic.
//
// Sections:
//   request: { wire, want: message | null | { throws } }   op 1
//   result:  { wire, want }                                  op 2, wire [r, result]
//   cause:   { wire, want: code }                            op 3
//   strict:  { op, wire, want }  rows the port refuses (see the decision crate docs); want is the
//            JS's answer, for the record
//
// The JS references (retired from production in #1071, so they live with the tests):
//   tests/server/oracle/decision.cjs

const path = require('node:path');
const server = path.join(__dirname, '..', 'server');
const { invalidRequestJs, invalidResultJs, causeOfJs } = require(path.join(__dirname, '..', 'tests', 'server', 'oracle', 'decision.cjs'));
const { decisionRequestTag, decisionResultTag, decisionErrorFacts } = require(path.join(server, 'dav-parse-wasm.cjs'));

const answer = (fn) => { try { return fn(); } catch { return { throws: true }; } };
const fn = function named() {};

const base = { kind: 'score', purpose: 'p', fallback: { selected: null }, constraints: { deadlineMs: 50 } };
const withFn = (k, v) => ({ ...base, [k]: v });

function requests() {
  const values = [undefined, null, 0, '', 'x', true, 1, fn, Symbol('s'), 10n, [], [base], base, { ...base }];
  for (const kind of ['choice', 'multi', 'rank', 'noul', 'score', 'Choice', '', undefined, ['choice'], 5]) values.push(withFn('kind', kind));
  for (const purpose of ['', 5, undefined, null, 'routing.sensitivity', ['p']]) values.push(withFn('purpose', purpose));
  for (const fallback of [undefined, null, 0, false, '', fn, {}]) values.push(withFn('fallback', fallback));
  for (const constraints of [undefined, null, 0, 5, 'x', true, {}, [], fn]) values.push(withFn('constraints', constraints));
  const fnc = function c() {}; fnc.deadlineMs = 5;
  values.push(withFn('constraints', fnc));
  for (const d of [0, -0, -1, 1, 0.5, NaN, Infinity, -Infinity, 5e-324, '5', ' 5 ', '\n5\t', '0x10', '0X0', '0b1', '0o7', '0b2', '-0x1', '', ' ', 'abc',
    '5ms', '1e3', '1e-400', '.5', '5.', '+5', '-5', '-0', 'Infinity', '-Infinity', 'infinity', '1_000', '\u00a01\ufeff', '\u0085 1', true, false, null, undefined]) {
    values.push(withFn('constraints', { deadlineMs: d }));
  }
  const holey = [, { id: 'a' }]; // eslint-disable-line no-sparse-arrays
  for (const kind of ['rank', 'choice', 'multi', 'noul', 'score']) {
    for (const list of [undefined, null, [], [{ id: 'a' }], holey, 'ab', { length: 1 }, [null], fn]) {
      values.push({ ...withFn('kind', kind), items: list, options: list });
      values.push({ ...withFn('kind', kind), [kind === 'rank' ? 'items' : 'options']: list });
    }
  }
  return values.map((r) => ({ wire: JSON.stringify(decisionRequestTag(r)), want: answer(() => invalidRequestJs(r)) }));
}

function results() {
  const opts = (ids) => ids.map((id) => ({ id, text: 'synthetic' }));
  const rs = [
    { kind: 'rank', items: opts(['a', 'b', 'c']) },
    { kind: 'choice', options: opts(['a', 'b']) },
    { kind: 'multi', options: opts(['a', 'b']) },
    { kind: 'score', options: opts(['a']) },
    { kind: 'noul' },
    { kind: 'choice', options: [{ id: NaN }, { id: -0 }, { text: 'no id' }, 'prim', 5, { id: null }, { id: '0' }] },
    { kind: 'rank', items: [{ id: 1 }, { id: '1' }, { id: true }] },
    { kind: 'choice', options: [null] },
    { kind: 'choice', options: 'ab' },
    { kind: 'rank', items: undefined },
    { kind: 'multi', options: null },
    { kind: 'score', options: 0 },
    'not an object',
  ];
  const results = [
    undefined, null, 5, 'x', fn, {}, [], { scores: null }, { scores: 5 }, { scores: 'x' }, { scores: fn }, { scores: {} },
    { scores: [] }, { scores: [1] }, { scores: { a: 1 } }, { scores: { a: 1, b: 0.5 } }, { scores: { c: 1 } }, { scores: { a: '1' } },
    { scores: { a: NaN } }, { scores: { a: Infinity } }, { scores: { a: -0 } }, { scores: { a: null } }, { scores: { a: {} } }, { scores: { a: 1, z: 2 } },
    { scores: { 0: 1 } }, { scores: { NaN: 1 } }, { scores: { 1: 1 } }, { scores: { true: 1 } }, { scores: { __proto__: null, a: 1 } },
  ];
  for (const selected of [['a', 'b'], ['b'], [], ['a', 'a'], ['c'], 'a', 'b', 'c', null, undefined, [NaN], [NaN, NaN], [-0, 0], [1, '1'], [true], NaN, -0, 0, '0',
    ['a', 'b', 'c'], { 0: 'a', length: 1 }, 1, true]) {
    results.push({ scores: { a: 0.9 }, selected });
    results.push({ scores: {}, selected });
  }
  const rows = [];
  for (const r of rs) for (const result of results) {
    rows.push({ wire: JSON.stringify([decisionRequestTag(r), decisionResultTag(result)]), want: answer(() => invalidResultJs(r, result)) });
  }
  return rows;
}

function causes() {
  const errs = [
    new Error('synthetic failure'), Object.assign(new Error('deadline'), { deadline: true }), { deadline: 1 }, { deadline: 0 }, { deadline: '' },
    Object.assign(new Error('x'), { reason: 'http-503' }), Object.assign(new Error('x'), { reason: 'Bad Reason' }), { reason: 'a'.repeat(40) },
    { reason: 'a'.repeat(41) }, { reason: '9lives' }, { reason: 'a-' }, { reason: 'a\n' }, { reason: 5 }, { reason: 'empty-response', deadline: true },
    Object.assign(new Error('x'), { name: 'AbortError' }), { name: 'TimeoutError' }, { name: 'aborterror' }, new DOMException('stop', 'AbortError'),
    new SyntaxError('Unexpected token'), Object.assign(new SyntaxError('x'), { reason: 'parse-x' }), new TypeError('fetch failed'),
    new TypeError('request to x: FETCH Failed, reason'), new TypeError('fetch  failed'), new TypeError('fetch fa\u0131led'), new TypeError('other'),
    Object.assign(new TypeError('fetch failed'), { name: 'AbortError' }), Object.assign(new TypeError(''), { message: 42 }), new RangeError('fetch failed'),
    null, undefined, 'fetch failed', 42, {}, [], { name: 5 },
  ];
  return errs.map((e) => ({ wire: JSON.stringify(decisionErrorFacts(e)), want: causeOfJs(e) }));
}

function strict() {
  const rows = [];
  const req = (r) => rows.push({ op: 1, wire: JSON.stringify(decisionRequestTag(r)), want: answer(() => invalidRequestJs(r)) });
  // Coercion of an object or bigint deadline; a bigint's truthiness.
  req(withFn('constraints', { deadlineMs: [5] }));
  req(withFn('constraints', { deadlineMs: { valueOf: () => 5 } }));
  req(withFn('constraints', { deadlineMs: 5n }));
  req(withFn('constraints', 0n));
  const res = (r, result) => rows.push({ op: 2, wire: JSON.stringify([decisionRequestTag(r), decisionResultTag(result)]), want: answer(() => invalidResultJs(r, result)) });
  // Object ids compare by identity; sparse arrays are not iterated.
  const shared = { k: 1 };
  res({ kind: 'choice', options: [{ id: shared }] }, { scores: {}, selected: shared });
  res({ kind: 'rank', items: [{ id: 'a' }] }, { scores: {}, selected: ['a', , 'a'] }); // eslint-disable-line no-sparse-arrays
  res({ kind: 'choice', options: [, { id: 'a' }] }, { scores: {}, selected: 'a' }); // eslint-disable-line no-sparse-arrays
  return rows;
}

process.stdout.write(`${JSON.stringify({ version: 1, request: requests(), result: results(), cause: causes(), strict: strict() })}\n`);
