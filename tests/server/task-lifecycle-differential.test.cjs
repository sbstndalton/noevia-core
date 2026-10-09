'use strict';

// Task lifecycle (TASK_LIFECYCLE_IMPL, retired in #1071: the port always confirms the JS): tests/fixtures/task-lifecycle.v1.json (byte-identical to noevia-rs
// crates/task-lifecycle/tests/fixtures/; CI compares them) holds task-lifecycle.cjs's table
// answers, stage moves and journal folds, printed by tools/gen-task-lifecycle-fixtures.cjs from the
// JS (the *Js functions of task-lifecycle.cjs, still the authority at runtime; synthetic journals only). Here every row runs through dav-parse.wasm's task_lifecycle
// and through the confirmed functions; then seeded live journals with non-ASCII text against the
// runtime's own JS: the port either agrees or refuses, the confirmed answer is always the JS one or
// a refusal, and false refusals are counted (none expected). The
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

test('pair rows: the same table answers through the Rust port and the confirmed functions', { skip: skipWasm }, () => {
  assert.ok(fixtures.pairs.length >= 200);
  for (const [i, row] of fixtures.pairs.entries()) {
    const [from, to] = JSON.parse(row.wire);
    assert.deepStrictEqual(davParseWasm.taskLifecycleCanTransition(from, to), row.want.canTransition, `row ${i} can`);
    assert.deepStrictEqual(davParseWasm.taskLifecycleTransition(from, to), row.want.transition, `row ${i} transition`);
    assert.deepStrictEqual(davParseWasm.taskLifecycleStageMove(from, to), row.want.stageMove, `row ${i} stage`);
    assert.deepStrictEqual(answer(() => lc.canTransition(from, to), 'allowed'), row.want.canTransition, `row ${i} confirmed can`);
    assert.deepStrictEqual(answer(() => lc.transition(from, to), 'state'), row.want.transition, `row ${i} confirmed transition`);
    assert.deepStrictEqual(answer(() => lc.assertStageMove(from, to), 'state'), row.want.stageMove, `row ${i} confirmed stage`);
  }
});

test('fold and derive rows: the same states and throw codes', { skip: skipWasm }, () => {
  assert.ok(fixtures.folds.length >= 250 && fixtures.derive.length >= 340);
  for (const [i, row] of fixtures.folds.entries()) {
    const [events, from, authoritative] = JSON.parse(row.wire);
    assert.deepStrictEqual(davParseWasm.taskLifecycleFold(events, from, authoritative), row.want, `fold ${i}`);
    assert.deepStrictEqual(answer(() => lc.foldEvents(events, from, { authoritative }), 'state'), row.want, `fold ${i} confirmed`);
  }
  for (const [i, row] of fixtures.derive.entries()) {
    const [events] = JSON.parse(row.wire);
    assert.deepStrictEqual(davParseWasm.taskLifecycleDerive(events), row.want, `derive ${i}`);
    assert.deepStrictEqual(answer(() => lc.deriveLifecycle(events), 'state'), row.want, `derive ${i} confirmed`);
    assert.equal(lc.safeDeriveLifecycle(events), row.want.state ?? null, `derive ${i} safe`);
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

test('600 seeded live journals: the confirmed answer is the JS one or a refusal; false refusals counted', { skip: skipWasm }, () => {
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
    const js = answer(() => lc.deriveLifecycleJs(events), 'state');
    const confirmed = quietly(() => answer(() => lc.deriveLifecycle(events), 'state'));
    if (js.state !== undefined && confirmed.state === undefined) falseRefusals++;
    else assert.deepStrictEqual(confirmed, js, `journal ${n}`);
    if (js.state !== undefined) agreed++;
    // The fold the jobs store uses, from planned, both modes.
    for (const authoritative of [false, true]) {
      const jf = answer(() => lc.foldEventsJs(events, 'planned', { authoritative }), 'state');
      const wf = quietly(() => answer(() => lc.foldEvents(events, 'planned', { authoritative }), 'state'));
      if (!(jf.state !== undefined && wf.state === undefined)) assert.deepStrictEqual(wf, jf, `journal ${n} fold ${authoritative}`);
      else falseRefusals++;
    }
  }
  assert.equal(falseRefusals, 0, 'the port refused a journal the JS folds');
  assert.ok(agreed >= 100, `${agreed}`);
});

test('#1126: a journal with over 8 MiB of tool payloads still confirms; the port sees only the fold input', { skip: skipWasm }, () => {
  const payload = 'p'.repeat(1024 * 1024);
  const events = [{ type: 'job.created', data: { kind: 'code' } }, { type: 'job.started' },
    ...Array.from({ length: 10 }, (_, i) => ({ type: 'tool.completed', data: { i, output: payload } })), { type: 'job.completed' }];
  assert.ok(JSON.stringify(events).length > davParseWasm.MAX_TASK_LIFECYCLE_BYTES);
  assert.equal(lc.deriveLifecycle(events), 'verifying');
  assert.equal(lc.foldEvents(events, 'planned'), 'verifying');
  assert.equal(lc.confirmFold(events, 'verifying'), 'verifying');
});

test('#1126: 5,000 appends with the real port stay close to the cost with a pass-through port (no quadratic re-send)', { skip: skipWasm }, () => {
  const os = require('node:os');
  const { createJobs } = require('../../server/jobs.cjs');
  const run = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-tl-diff-'));
    try {
      const jobs = createJobs({ dir, kinds: ['code'], maxJobs: 10 });
      const id = jobs.create({ kind: 'code', projectId: 'p-synthetic', capabilities: ['read'] });
      jobs.append(id, 'job.started', {});
      const started = process.hrtime.bigint();
      for (let i = 0; i < 5000; i++) jobs.append(id, i % 50 ? 'tool.completed' : 'progress', i % 50 ? { i, output: 'o'.repeat(512) } : { stage: 'implementing' });
      return { ms: Number(process.hrtime.bigint() - started) / 1e6, lifecycle: jobs.get(id).lifecycle };
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  };
  // The stand-in answers with the JS fold of the same input, so only the port's own cost differs.
  const real = davParseWasm.taskLifecycleFold;
  davParseWasm.taskLifecycleFold = (events, from, authoritative) => ({ state: lc.foldEventsJs(events, from, { authoritative }) });
  let base;
  try { base = run(); } finally { davParseWasm.taskLifecycleFold = real; }
  const w = run();
  assert.equal(base.lifecycle, 'implementing');
  assert.equal(w.lifecycle, 'implementing');
  assert.ok(w.ms < base.ms * 1.5 + 3000, `port ${Math.round(w.ms)} ms vs pass-through ${Math.round(base.ms)} ms`);
});

test('an over-size journal is refused (too_large), the JS answer is not', { skip: skipWasm }, () => {
  // Over the cap in the fold input itself (a progress stage the fold reads).
  const events = [{ type: 'job.started' }, { type: 'progress', data: { stage: 'x'.repeat(davParseWasm.MAX_TASK_LIFECYCLE_BYTES) } }];
  assert.throws(() => davParseWasm.taskLifecycleDerive(events), { reason: 'too_large' });
  assert.equal(lc.deriveLifecycleJs(events), 'implementing');
  quietly(() => assert.equal(lc.safeDeriveLifecycle(events), null));
});
