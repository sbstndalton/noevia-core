'use strict';

// DECISION_IMPL: tests/fixtures/decision.v1.json (byte-identical to noevia-rs
// crates/decision/tests/fixtures/; CI compares them) holds decision/index.cjs's invalidRequest,
// invalidResult and causeOf answers over dav-parse-wasm.cjs's own projection, printed by
// tools/gen-decision-fixtures.cjs from the JS itself (synthetic values only). Here every row runs
// through dav-parse.wasm's decision call and must agree (a refusal where the JS throws); then
// seeded live requests and answers, whole decide() calls under both settings, the switch, and the
// fail-closed paths: a fault never lets a backend's answer through. The WebAssembly half needs
// server/wasm/dav-parse.wasm (or DAV_PARSE_WASM); skipped without it unless DAV_PARSE_WASM_REQUIRED=1.

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const davParseWasm = require('../../server/dav-parse-wasm.cjs');
const decision = require('../../server/decision/index.cjs');

const FILE = path.join(__dirname, '../fixtures/decision.v1.json');
const GENERATOR = path.join(__dirname, '../../tools/gen-decision-fixtures.cjs');
const fixtures = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const wasmFile = process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM;
const skipWasm = !fs.existsSync(wasmFile) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built';

const quiet = (fn) => { const warn = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = warn; } };
const attempt = (fn) => { try { return fn(); } catch { return { throws: true }; } };

test('the fixture file is what the generator prints', { skip: !fs.existsSync(GENERATOR) && 'no generator here' }, () => {
  const out = execFileSync(process.execPath, [GENERATOR], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(out, fs.readFileSync(FILE, 'utf8'));
});

test('fixture rows: the same message or code through the Rust port, a refusal where the JS throws', { skip: skipWasm }, () => {
  const raw = (op, wire) => { try { return davParseWasm.decisionRequest(op, JSON.parse(wire)); } catch (err) { return { error: err.reason }; } };
  for (const [section, op, key] of [['request', 1, 'invalid'], ['result', 2, 'invalid'], ['cause', 3, 'cause']]) {
    fixtures[section].forEach((row, i) => {
      const want = row.want && row.want.throws ? { error: 'throws' } : { [key]: row.want };
      assert.deepStrictEqual(raw(op, row.wire), want, `${section} row ${i}: ${row.wire.slice(0, 200)}`);
    });
  }
  fixtures.strict.forEach((row, i) => assert.deepStrictEqual(raw(row.op, row.wire), { error: 'opaque' }, `strict row ${i}`));
});

test('seeded live requests and answers agree; a fault only where the JS throws', { skip: skipWasm }, () => {
  let seed = 777;
  const rnd = (m) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 16) % m; };
  const pick = (xs) => xs[rnd(xs.length)];
  const ID = () => pick(['a', 'b', 'c', '', '0', 0, -0, NaN, 1, true, null, undefined]);
  const SCALAR = () => pick([0, -0, 1, 0.5, NaN, Infinity, -1, '1', '', 'x', null, undefined, true, false]);
  const list = () => pick([undefined, null, 'ab', [], () => {}, Array.from({ length: rnd(4) }, () => pick([{ id: ID() }, { id: ID(), text: 't' }, {}, 'p', 5, null]))]);
  const request = () => ({
    kind: pick(['rank', 'choice', 'multi', 'noul', 'score', 'x', undefined]),
    purpose: pick(['p', '', 5, undefined]),
    fallback: pick([{ selected: null }, undefined, null, 0]),
    constraints: pick([undefined, null, 0, 'x', {}, { deadlineMs: pick([SCALAR(), ' 5 ', '0x1', '1e-400', '-0', '5.', '.5', 'Infinity']) }]),
    items: list(),
    options: list(),
  });
  const result = () => pick([
    () => SCALAR(),
    () => ({ scores: pick([null, 5, 'x', [], [1], {}, Object.fromEntries(Array.from({ length: rnd(4) }, () => [pick(['a', 'b', 'c', 'z', '0', 'NaN']), SCALAR()]))]),
      selected: pick([() => Array.from({ length: rnd(4) }, ID), ID, () => ['a', 'a'], () => 'a'])() }),
  ])();
  let faults = 0;
  for (let i = 0; i < 3000; i++) {
    const r = request();
    const jsReq = attempt(() => decision.invalidRequestJs(r));
    const wasmReq = quiet(() => decision.invalidRequest(r, { impl: 'wasm' }));
    if (jsReq && jsReq.throws) { assert.equal(wasmReq, decision.REQUEST_FAULT, `iteration ${i}`); faults++; } else assert.equal(wasmReq, jsReq, `iteration ${i}: request`);
    const res = result();
    const jsRes = attempt(() => decision.invalidResultJs(r, res));
    const wasmRes = quiet(() => decision.invalidResult(r, res, { impl: 'wasm' }));
    if (jsRes && jsRes.throws) { assert.equal(wasmRes, decision.RESULT_FAULT, `iteration ${i}`); faults++; } else assert.equal(wasmRes, jsRes, `iteration ${i}: result`);
  }
  assert.ok(faults > 100, `${faults} faults`);
  for (const e of [new TypeError('fetch failed'), Object.assign(new Error('x'), { reason: 'http-502' }), new SyntaxError('x'), null, 'x', { deadline: true }]) {
    assert.equal(decision.causeOf(e, { impl: 'wasm' }), decision.causeOfJs(e));
  }
});

test('whole decide() calls: the same answer under both settings', { skip: skipWasm }, async () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const fallback = { selected: ['c', 'b', 'a'], scores: { a: 0, b: 0, c: 0 } };
  const answers = [
    { selected: ['a', 'b', 'c'], scores: { a: 3, b: 2, c: 1 } }, { selected: ['a', 'a'], scores: { a: 1 } }, { selected: ['z'], scores: { a: 1 } },
    { selected: ['a'], scores: { z: 1 } }, { selected: ['a'], scores: { a: '1' } }, null, { scores: {} },
  ];
  const errors = [Object.assign(new Error('x'), { reason: 'http-503' }), new TypeError('fetch failed'), new SyntaxError('x')];
  const run = async (impl, answer, error, request) => {
    const logs = [];
    const backend = { locality: 'local', supports: () => true, decide: async () => { if (error) throw error; return answer; } };
    const d = createWith(impl, backend, logs);
    const out = await d.decide(request);
    return { out, logs };
  };
  const createWith = (impl, backend, logs) => decision.createDecisions({ backends: { b: backend }, chains: { p: ['b'] }, log: (e) => logs.push(e), now: () => 0, impl });
  const requests = [
    { kind: 'rank', purpose: 'p', items, fallback, constraints: { deadlineMs: 100 } },
    { kind: 'rank', purpose: 'p', items: [], fallback, constraints: { deadlineMs: 100 } },
    { kind: 'choice', purpose: 'p', options: items, fallback: { selected: 'a', scores: {} }, constraints: { deadlineMs: '100' } },
    { kind: 'score', purpose: 'p', fallback, constraints: {} },
  ];
  for (const request of requests) {
    for (const answer of answers) assert.deepStrictEqual(await run('wasm', answer, null, request), await run('js', answer, null, request));
    for (const error of errors) assert.deepStrictEqual(await run('wasm', null, error, request), await run('js', null, error, request));
  }
});

test('DECISION_IMPL: default js, wasm by name, anything else js with one warning', () => {
  assert.equal(decision.decisionImpl({}), 'js');
  assert.equal(decision.decisionImpl({ DECISION_IMPL: 'Wasm ' }), 'wasm');
  const warn = console.warn, seen = [];
  console.warn = (m) => seen.push(m);
  try {
    assert.equal(decision.decisionImpl({ DECISION_IMPL: 'yes' }), 'js');
    assert.equal(decision.decisionImpl({ DECISION_IMPL: 'yes' }), 'js');
  } finally { console.warn = warn; }
  assert.equal(seen.length, 1);
  assert.ok(davParseWasm.IMPL_FLAGS.includes('DECISION_IMPL'));
});

test('fail closed: a fault makes the request or the answer invalid, and the fallback answers', async () => {
  const items = [{ id: 'a' }];
  const fallback = { selected: ['a'], scores: { a: 0 } };
  const request = { kind: 'rank', purpose: 'p', items, fallback, constraints: { deadlineMs: 100 } };
  let reached = 0;
  const backend = { locality: 'local', supports: () => true, decide: async () => { reached++; return { selected: ['a'], scores: { a: 1 } }; } };
  const trap = () => { throw Object.assign(new Error('trap'), { reason: 'trap' }); };
  // invalidRequest faults: the backend is never reached.
  const d1 = decision.createDecisions({ backends: { b: backend }, chains: { p: ['b'] }, impl: 'wasm', wasmLoader: () => ({ decisionInvalidRequest: trap }) });
  const r1 = await quiet(() => d1.decide(request));
  assert.equal(r1.source, 'fallback');
  assert.match(r1.metadata.fellBack, /could not be checked/);
  assert.equal(reached, 0);
  // invalidResult faults: the backend's answer is never used.
  const d2 = decision.createDecisions({ backends: { b: backend }, chains: { p: ['b'] }, impl: 'wasm', wasmLoader: () => ({ decisionInvalidRequest: () => null, decisionInvalidResult: trap }) });
  const r2 = await quiet(() => d2.decide(request));
  assert.equal(r2.source, 'fallback');
  assert.equal(r2.metadata.cause, 'invalid-result');
  assert.equal(reached, 1);
  assert.equal(quiet(() => decision.causeOf(new TypeError('fetch failed'), { impl: 'wasm', wasmLoader: () => ({ decisionCauseOf: trap }) })), 'exception');
  // A missing module.
  const saved = process.env.DAV_PARSE_WASM;
  process.env.DAV_PARSE_WASM = path.join(__dirname, 'no-such-dav-parse.wasm');
  try {
    davParseWasm.reset();
    assert.equal(quiet(() => decision.invalidRequest(request, { impl: 'wasm' })), decision.REQUEST_FAULT);
    assert.equal(quiet(() => decision.invalidResult(request, { selected: ['a'], scores: { a: 1 } }, { impl: 'wasm' })), decision.RESULT_FAULT);
    assert.throws(() => davParseWasm.verifyAtStartup({ DECISION_IMPL: 'wasm', DAV_PARSE_WASM: process.env.DAV_PARSE_WASM }), /DECISION_IMPL/);
  } finally {
    if (saved === undefined) delete process.env.DAV_PARSE_WASM; else process.env.DAV_PARSE_WASM = saved;
    davParseWasm.reset();
  }
});

test('strict: identities, sparse arrays and object coercion are faults, never a pass', { skip: skipWasm }, () => {
  const shared = { k: 1 };
  const r = { kind: 'choice', purpose: 'p', options: [{ id: shared }], fallback: {}, constraints: { deadlineMs: 5 } };
  assert.equal(decision.invalidResultJs(r, { scores: {}, selected: shared }), null);
  assert.equal(quiet(() => decision.invalidResult(r, { scores: {}, selected: shared }, { impl: 'wasm' })), decision.RESULT_FAULT);
  const rank = { kind: 'rank', purpose: 'p', items: [{ id: 'a' }, { id: 'b' }], fallback: {}, constraints: { deadlineMs: { valueOf: () => 5 } } };
  assert.equal(decision.invalidRequestJs(rank), null);
  assert.equal(quiet(() => decision.invalidRequest(rank, { impl: 'wasm' })), decision.REQUEST_FAULT);
  // Over the entry cap a ranking is not iterated; within it, the same answer.
  const many = Array.from({ length: davParseWasm.DECISION_ENTRIES + 1 }, (_, i) => ({ id: `i${i}` }));
  const big = { ...rank, constraints: { deadlineMs: 5 }, items: many };
  assert.equal(quiet(() => decision.invalidRequest(big, { impl: 'wasm' })), null);
  assert.equal(quiet(() => decision.invalidResult(big, { scores: {}, selected: ['i1'] }, { impl: 'wasm' })), decision.RESULT_FAULT);
  const fit = { ...big, items: many.slice(0, davParseWasm.DECISION_ENTRIES) };
  const sel = fit.items.map((o) => o.id).reverse();
  assert.equal(decision.invalidResult(fit, { scores: { i0: 1 }, selected: sel }, { impl: 'wasm' }), decision.invalidResultJs(fit, { scores: { i0: 1 }, selected: sel }));
});
