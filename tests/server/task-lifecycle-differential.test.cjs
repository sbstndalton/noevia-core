'use strict';

// TASK_LIFECYCLE_IMPL: tests/fixtures/task-lifecycle.v1.json (byte-identical to noevia-rs
// crates/task-lifecycle/tests/fixtures/; CI compares them) holds task-lifecycle.cjs's table
// answers, stage moves and journal folds, printed by tools/gen-task-lifecycle-fixtures.cjs from the
// JS itself (synthetic journals only). Here every row runs through dav-parse.wasm's task_lifecycle
// and through the switched functions; then seeded live journals with non-ASCII text against the
// runtime's own JS: the port either agrees or refuses, the switched answer is always the JS one or
// a refusal, and false refusals are counted (none expected outside the strict rows). The
// WebAssembly half needs server/wasm/dav-parse.wasm (or DAV_PARSE_WASM); skipped without it unless
// DAV_PARSE_WASM_REQUIRED=1.

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const davParseWasm = require('../../server/dav-parse-wasm.cjs');
const lc = require('../../server/task-lifecycle.cjs');

const FILE = path.join(__dirname, '../fixtures/task-lifecycle.v1.json');
const GENERATOR = path.join(__dirname, '../../tools/gen-task-lifecycle-fixtures.cjs');
const fixtures = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const wasmFile = process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM;
const skipWasm = !fs.existsSync(wasmFile) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built';

const JS = { impl: 'js' }, WASM = { impl: 'wasm' };
const answer = (fn, key) => {
  try { return { [key]: fn() }; } catch (err) { if (err instanceof lc.TaskLifecycleError) return { throws: err.code }; throw err; }
};
function quietly(fn) {
  const warn = console.warn;
  console.warn = () => {};
  try { return fn(); } finally { console.warn = warn; }
}

test('the fixture file is what the generator prints', { skip: !fs.existsSync(GENERATOR) && 'no generator here' }, () => {
  const out = execFileSync(process.execPath, [GENERATOR], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  assert.equal(out, fs.readFileSync(FILE, 'utf8'));
});

test('pair rows: the same table answers through the Rust port and the switched functions', { skip: skipWasm }, () => {
  assert.ok(fixtures.pairs.length >= 200);
  for (const [i, row] of fixtures.pairs.entries()) {
    const [from, to] = JSON.parse(row.wire);
    assert.deepStrictEqual(davParseWasm.taskLifecycleCanTransition(from, to), row.want.canTransition, `row ${i} can`);
    assert.deepStrictEqual(davParseWasm.taskLifecycleTransition(from, to), row.want.transition, `row ${i} transition`);
    assert.deepStrictEqual(davParseWasm.taskLifecycleStageMove(from, to), row.want.stageMove, `row ${i} stage`);
    assert.deepStrictEqual(answer(() => lc.canTransition(from, to, WASM), 'allowed'), row.want.canTransition, `row ${i} switched can`);
    assert.deepStrictEqual(answer(() => lc.transition(from, to, WASM), 'state'), row.want.transition, `row ${i} switched transition`);
    assert.deepStrictEqual(answer(() => lc.assertStageMove(from, to, WASM), 'state'), row.want.stageMove, `row ${i} switched stage`);
  }
});

test('fold and derive rows: the same states and throw codes', { skip: skipWasm }, () => {
  assert.ok(fixtures.folds.length >= 250 && fixtures.derive.length >= 340);
  for (const [i, row] of fixtures.folds.entries()) {
    const [events, from, authoritative] = JSON.parse(row.wire);
    assert.deepStrictEqual(davParseWasm.taskLifecycleFold(events, from, authoritative), row.want, `fold ${i}`);
    assert.deepStrictEqual(answer(() => lc.foldEvents(events, from, { authoritative, ...WASM }), 'state'), row.want, `fold ${i} switched`);
  }
  for (const [i, row] of fixtures.derive.entries()) {
    const [events] = JSON.parse(row.wire);
    assert.deepStrictEqual(davParseWasm.taskLifecycleDerive(events), row.want, `derive ${i}`);
    assert.deepStrictEqual(answer(() => lc.deriveLifecycle(events, WASM), 'state'), row.want, `derive ${i} switched`);
    assert.equal(lc.safeDeriveLifecycle(events, WASM), row.want.state ?? null, `derive ${i} safe`);
  }
});

test('strict rows: the port refuses as ambiguous; the switched derive refuses', { skip: skipWasm }, () => {
  for (const [i, row] of fixtures.strict.entries()) {
    const [events] = JSON.parse(row.wire);
    assert.deepStrictEqual(row.want, { refused: 'ambiguous' });
    assert.throws(() => davParseWasm.taskLifecycleDerive(events), { reason: 'ambiguous' }, `strict ${i}`);
    // Where the JS throws itself (a TypeError, or report_hash for [h, h]) that error stands;
    // where it answers (a [hash] passes String()), the switched call refuses.
    let jsError = null;
    try { lc.deriveLifecycle(events, JS); } catch (e) { jsError = e; }
    quietly(() => assert.throws(() => lc.deriveLifecycle(events, WASM),
      (e) => (jsError ? e.constructor === jsError.constructor && e.code === jsError.code : e.code === 'impl_refused'), `strict ${i}`));
    if (!jsError || jsError instanceof lc.TaskLifecycleError) quietly(() => assert.equal(lc.safeDeriveLifecycle(events, WASM), null, `strict ${i}`));
    else assert.throws(() => lc.safeDeriveLifecycle(events, WASM), TypeError, `strict ${i}`);
  }
});

// Seeded live journals: the fixture vocabulary plus non-ASCII and odd text the table avoids.
function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('600 seeded live journals: the switched answer is the JS one or a refusal; false refusals counted', { skip: skipWasm }, () => {
  const rand = mulberry32(0x11fe);
  const pick = (xs) => xs[Math.floor(rand() * xs.length)];
  const HASH = '0123456789abcdef'.repeat(4);
  const TEXT = ['Ünïcödé', 'ß', 'İ', 'K', 'ﬀ', '😀', '\ud800', 'a\u0000b', 'é'.normalize('NFD'), 'planned​'];
  const STATES = [...lc.STATES, 'Merged', 'reviewing ', pick(TEXT)];
  const TYPES = ['job.created', 'job.started', 'job.completed', 'job.failed', 'job.cancelled', 'job.interrupted', 'progress',
    'approval.requested', 'approval.decided', 'task.revision', 'tool.completed', 'Task.stage', 'job.started́'];
  let falseRefusals = 0, agreed = 0;
  for (let n = 0; n < 600; n++) {
    let state = 'planned';
    const events = [];
    for (let k = Math.floor(rand() * 16); k > 0; k--) {
      const r = rand();
      if (r < 0.4) {
        const to = pick(STATES);
        const data = { from: rand() < 0.85 ? state : pick(STATES), to, revision: 0, reason: pick(TEXT) };
        if (to === 'reviewing') data.reportHash = pick([HASH, HASH, HASH.toUpperCase(), pick(TEXT), 0, null]);
        events.push({ type: 'task.stage', at: n, data });
      } else {
        events.push({ type: pick(TYPES), at: n, data: rand() < 0.3 ? { stage: pick(['implementing', 'verifying', pick(TEXT)]), note: pick(TEXT) } : { note: pick(TEXT) } });
      }
      try { state = lc.step(state, events.at(-1), { authoritative: true }); } catch { /* keep the guess */ }
    }
    const js = answer(() => lc.deriveLifecycle(events, JS), 'state');
    const switched = quietly(() => answer(() => lc.deriveLifecycle(events, WASM), 'state'));
    if (js.state !== undefined && switched.state === undefined) falseRefusals++;
    else assert.deepStrictEqual(switched, js, `journal ${n}`);
    if (js.state !== undefined) agreed++;
    // The fold the jobs store uses, from planned, both modes.
    for (const authoritative of [false, true]) {
      const jf = answer(() => lc.foldEvents(events, 'planned', { authoritative, ...JS }), 'state');
      const wf = quietly(() => answer(() => lc.foldEvents(events, 'planned', { authoritative, ...WASM }), 'state'));
      if (!(jf.state !== undefined && wf.state === undefined)) assert.deepStrictEqual(wf, jf, `journal ${n} fold ${authoritative}`);
      else falseRefusals++;
    }
  }
  assert.equal(falseRefusals, 0, 'the port refused a journal the JS folds');
  assert.ok(agreed >= 100, `${agreed}`);
});

test('an over-size journal is refused (too_large), the JS answer is not', { skip: skipWasm }, () => {
  const events = [{ type: 'job.started', data: { note: 'x'.repeat(davParseWasm.MAX_TASK_LIFECYCLE_BYTES) } }];
  assert.throws(() => davParseWasm.taskLifecycleDerive(events), { reason: 'too_large' });
  assert.equal(lc.deriveLifecycle(events, JS), 'implementing');
  quietly(() => assert.equal(lc.safeDeriveLifecycle(events, WASM), null));
});
