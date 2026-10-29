'use strict';
// #223: an evaluator fault in autoconfig must not take the service down at boot; it surfaces per request and
// stays fail-closed. Two boot-time reads used to stop startup: llamacpp-calibration.cjs read CTX_CANDIDATES when
// the module loaded, and server/index.cjs called parseMemoryLimit while building the model manager. Now the
// first is read on first use (a successful read is memoized, a fault never is) and the second is caught, logged
// once and kept as the reason the budget-dependent features refuse with. A fault never permits and never
// supplies a figure or a list of its own (#1071). Each guarded body counts ran++ and test.after asserts the total.
// Synthetic GGUF header and a fake router only: nothing is loaded. The real-server boot cases are in
// tests/server/llamacpp-lazy-startup-223-boot.test.cjs.
// Needs server/wasm/dav-parse.wasm (or DAV_PARSE_WASM); skipped without it unless DAV_PARSE_WASM_REQUIRED=1.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const davParseWasm = require('./dav-parse-wasm.cjs');
const { createModelManager } = require('./model-manager.cjs');

const skipWasm = !fs.existsSync(process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built';
const AUTOCONFIG = path.join(__dirname, 'llamacpp-autoconfig.cjs');
const CALIBRATION = path.join(__dirname, 'llamacpp-calibration.cjs');
const HOST = path.join(__dirname, 'llamacpp-autoconfig-host.cjs');
// 31 since #2189 moved the suggestion and the estimate to the Rust front (noevia-rs model_sizing.rs).
const EXPECTED_RAN = 31;

let ran = 0;
test.after(() => { assert.equal(ran, skipWasm ? 0 : EXPECTED_RAN, 'every guarded body must have run'); });

function gguf(kv) {
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const str = (s) => { const b = Buffer.from(s); return Buffer.concat([u64(b.length), b]); };
  const val = (type, v) => (type === 4 ? u32(v) : str(v));
  return Buffer.concat([Buffer.from('GGUF'), u32(3), u64(0), u64(Object.keys(kv).length), ...Object.entries(kv).map(([k, [t, v]]) => Buffer.concat([str(k), u32(t), val(t, v)]))]);
}
const HEADER = { 'general.architecture': [8, 'llama'], 'llama.context_length': [4, 8192], 'llama.embedding_length': [4, 4096], 'llama.block_count': [4, 32], 'llama.attention.head_count': [4, 32], 'llama.attention.head_count_kv': [4, 8], 'tokenizer.chat_template': [8, '{{ messages }}'] };
const INI = 'version = 1\n\n[small]\nmodel = /models/q.gguf\nctx-size = 4096\ncache-ram = 0\n';
const FAULT_REASON = 'the container memory limit (LLAMACPP_MEMORY_LIMIT) could not be evaluated at startup: synthetic';
const SYNTHETIC_FAULT = () => { throw new davParseWasm.DavParseError('synthetic evaluator fault', 'trap'); };

// The evaluator entry point replaced for the whole process: every call faults. `probe.ran` counts the calls.
function faultyEvaluator(t) {
  const saved = davParseWasm.llamacppAutoconfig, probe = { ran: 0 };
  davParseWasm.llamacppAutoconfig = () => { probe.ran++; return SYNTHETIC_FAULT(); };
  const warn = console.warn; console.warn = () => {};
  t.after(() => { console.warn = warn; davParseWasm.llamacppAutoconfig = saved; });
  return probe;
}
function withEvaluator(fn, run) {
  const saved = davParseWasm.llamacppAutoconfig;
  davParseWasm.llamacppAutoconfig = fn;
  try { return run(); } finally { davParseWasm.llamacppAutoconfig = saved; }
}
// Fresh copies of the autoconfig and calibration modules (the autoconfig getters cache a successful read).
function freshModules(t) {
  // The host module also keeps the evaluator's own state (its constants), so it is reloaded too.
  const drop = () => { for (const file of [AUTOCONFIG, CALIBRATION, HOST]) delete require.cache[file]; };
  drop(); t.after(drop);
  return { autoconfig: () => require(AUTOCONFIG), calibration: () => require(CALIBRATION) };
}
async function settle(m) {
  m.calibration.cancel();
  for (let i = 0; i < 400 && m.calibration.status().body.job?.status === 'running'; i++) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.notEqual(m.calibration.status().body.job?.status, 'running', 'the cancelled calibration must stop');
}

function synthetic(t, { autoconfig = {}, inferenceBudget, native, autotuneOptions } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazy-223-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'q.gguf'), gguf(HEADER));
  const ini = path.join(dir, 'models.ini');
  fs.writeFileSync(ini, INI);
  const calls = [], state = { small: 'unloaded' };
  const m = createModelManager({ kind: 'llamacpp', baseUrl: 'http://synthetic', presetPath: ini, calibrationStatePath: path.join(dir, 'cal.json'), autotuneStatePath: path.join(dir, 'tune.json'), gate: require('./fixtures/fake-inference-gate.cjs').fakeGate(),
    autoconfig: { modelsPath: dir, cacheRamMaxMib: 1024, ...autoconfig }, ...(inferenceBudget ? { inferenceBudget } : {}),
    calibrationOptions: { sleep: async () => {}, readMemory: () => 20 }, ...(autotuneOptions ? { autotuneOptions } : {}),
    fetchJson: async (url, options = {}) => {
      const p = new URL(url).pathname;
      calls.push(`${options.method || 'GET'} ${p}`);
      if (p === '/models/load') state.small = 'loaded';
      if (p === '/models/unload') state.small = 'unloaded';
      return { ok: true, status: 200, body: p === '/models' ? { data: [{ id: 'small', status: { value: state.small }, ...(native ? { meta: { n_ctx_train: native } } : {}) }] } : { success: true } };
    } });
  return { m, calls, ini };
}
const WRITES = (calls) => calls.filter(c => c.startsWith('POST') && c !== 'POST /models/unload');

// ---- calibration: CTX_CANDIDATES is read on first use ------------------------------------------------------

test('calibration: requiring the module no longer reads CTX_CANDIDATES, so a faulty evaluator cannot stop the load', { skip: skipWasm }, (t) => {
  const probe = faultyEvaluator(t);
  const mods = freshModules(t);
  const calibration = mods.calibration();
  ran++;
  assert.equal(probe.ran, 0, 'loading the module must not touch the evaluator');
  assert.equal(typeof calibration.ladder, 'function');
  assert.equal(typeof calibration.createCalibrator, 'function');
});

test('calibration: ladder() under a fault throws the autoconfig_impl refusal (503), never a default list', { skip: skipWasm }, (t) => {
  const probe = faultyEvaluator(t);
  const { ladder } = freshModules(t).calibration();
  for (const native of [0, 32768, 131072, 262144, -1, NaN]) {
    assert.throws(() => ladder(native), (e) => e.name === 'AutoconfigImplError' && e.code === 'autoconfig_impl' && e.status === 503 && /context ladder/.test(e.message), String(native));
    ran++;
  }
  assert.ok(probe.ran >= 6, 'each call must reach the faulty evaluator (a fault is not memoized)');
});

test('calibration: a non-fault throw, or a non-list, from the CTX_CANDIDATES read is still the fail-closed refusal', { skip: skipWasm }, (t) => {
  const mods = freshModules(t);
  const ac = mods.autoconfig();
  const { ladder } = mods.calibration();
  Object.defineProperty(ac, 'CTX_CANDIDATES', { get() { throw new RangeError('synthetic getter fault'); }, configurable: true, enumerable: true });
  assert.throws(() => ladder(32768), (e) => e.code === 'autoconfig_impl' && e.status === 503 && e.cause instanceof RangeError);
  ran++;
  Object.defineProperty(ac, 'CTX_CANDIDATES', { get() { return 'not a list'; }, configurable: true, enumerable: true });
  assert.throws(() => ladder(32768), (e) => e.code === 'autoconfig_impl' && e.status === 503);
  ran++;
});

test('calibration: a fault leaves nothing memoized, the first good read is kept, and a later fault does not change it', { skip: skipWasm }, (t) => {
  const { ladder } = freshModules(t).calibration();
  withEvaluator(SYNTHETIC_FAULT, () => assert.throws(() => ladder(32768), (e) => e.code === 'autoconfig_impl'));
  ran++;
  const normal = ladder(32768);
  assert.ok(normal.length > 1 && normal[0] === 4096 && normal.at(-1) === 32768, JSON.stringify(normal));
  ran++;
  let asked = 0;
  withEvaluator(() => { asked++; return SYNTHETIC_FAULT(); }, () => assert.deepEqual(ladder(32768), normal));
  assert.equal(asked, 0, 'a memoized ladder must not read the evaluator again');
  ran++;
});

test('calibration: the normal ladder is unchanged by the lazy read', { skip: skipWasm }, (t) => {
  const mods = freshModules(t);
  const { ladder } = mods.calibration();
  const { CTX_CANDIDATES } = mods.autoconfig();
  assert.equal(ladder(32768).at(-1), 32768); assert.equal(ladder(0).at(-1), 131072);
  assert.ok(ladder(100000).includes(100000)); assert.equal(ladder(262144)[0], 4096);
  assert.deepEqual(ladder(262144), [...new Set([...CTX_CANDIDATES, 262144])].filter((c) => c >= 4096 && c <= 262144).sort((a, b) => a - b));
  ran++;
});

test('calibration: start() refuses with 503 autoconfig_impl before holding the gate, touching the preset or loading anything', { skip: skipWasm }, async (t) => {
  const probe = faultyEvaluator(t);
  freshModules(t);
  const { m, calls, ini } = synthetic(t, { native: 32768 });
  const before = fs.readFileSync(ini, 'utf8');
  const r = await m.calibration.start('small', { confirmPause: true, promptBudgetSeconds: 30 });
  ran++;
  assert.ok(probe.ran > 0);
  assert.equal(r.ok, false); assert.equal(r.status, 503); assert.equal(r.body.code, 'autoconfig_impl');
  assert.match(r.body.error, /^Calibration is unavailable: .*context ladder/);
  assert.equal(fs.readFileSync(ini, 'utf8'), before, 'the preset file is untouched');
  assert.deepEqual(WRITES(calls), [], calls.join('\n'));
  assert.equal(m.calibration.status().body.job, null);
  assert.equal(m.tuningActive(), false, 'the maintenance gate was never held');
});

test('calibration: a getter-level fault refuses the same way, and other validation answers first and unchanged', { skip: skipWasm }, async (t) => {
  const mods = freshModules(t);
  Object.defineProperty(mods.autoconfig(), 'CTX_CANDIDATES', { get() { throw new Error('synthetic getter fault'); }, configurable: true, enumerable: true });
  const { m, calls } = synthetic(t, { native: 32768 });
  const r = await m.calibration.start('small', { confirmPause: true, promptBudgetSeconds: 30 });
  ran++;
  assert.equal(r.status, 503); assert.equal(r.body.code, 'autoconfig_impl');
  assert.deepEqual(WRITES(calls), []);
  assert.equal((await m.calibration.start('small', { promptBudgetSeconds: 30 })).status, 400);
  assert.equal((await m.calibration.start('small', { confirmPause: true, promptBudgetSeconds: 5 })).status, 400);
  assert.equal((await m.calibration.start('missing', { confirmPause: true, promptBudgetSeconds: 30 })).status, 404);
  ran++;
});

test('calibration: with the real evaluator start() is accepted (202) and can be cancelled', { skip: skipWasm }, async (t) => {
  freshModules(t);
  const { m } = synthetic(t, { native: 8192 });
  const r = await m.calibration.start('small', { confirmPause: true, promptBudgetSeconds: 30 });
  ran++;
  assert.equal(r.ok, true); assert.equal(r.status, 202);
  await settle(m);
});

// ---- auto-tune: the ladder fault refuses instead of falling back to the standard order ----------------------

async function tuneSettled(m) {
  for (let i = 0; i < 400 && m.autotune.status().body.job?.status === 'running'; i++) await new Promise((resolve) => setTimeout(resolve, 25));
  return m.autotune.status().body.job;
}
const TUNE = { confirmPause: true, promptBudgetSeconds: 30 };

test('auto-tune: a CTX_CANDIDATES getter fault refuses start() with 503 autoconfig_impl before any hold or write', { skip: skipWasm }, async (t) => {
  const mods = freshModules(t);
  Object.defineProperty(mods.autoconfig(), 'CTX_CANDIDATES', { get() { throw new Error('synthetic getter fault'); }, configurable: true, enumerable: true });
  const { m, calls, ini } = synthetic(t, { native: 32768, inferenceBudget: { budgetGib: () => 64 } });
  const before = fs.readFileSync(ini, 'utf8');
  const r = await m.autotune.start('small', TUNE);
  ran++;
  assert.equal(r.ok, false); assert.equal(r.status, 503); assert.equal(r.body.code, 'autoconfig_impl');
  assert.match(r.body.error, /^Auto-tune is unavailable: .*context ladder/);
  assert.ok(!m.autotune.status().body.job, 'no job record');
  assert.equal(m.tuningActive(), false, 'the gate was never held');
  assert.equal(fs.readFileSync(ini, 'utf8'), before);
  assert.deepEqual(WRITES(calls), [], calls.join('\n'));
  // Validation still answers first and unchanged.
  assert.equal((await m.autotune.start('small', { promptBudgetSeconds: 30 })).status, 400);
});

test('auto-tune: an evaluator-wide fault refuses start() the same way and loads nothing', { skip: skipWasm }, async (t) => {
  const probe = faultyEvaluator(t);
  freshModules(t);
  const { m, calls, ini } = synthetic(t, { native: 32768, inferenceBudget: { budgetGib: () => 64 } });
  const before = fs.readFileSync(ini, 'utf8');
  const r = await m.autotune.start('small', TUNE);
  ran++;
  assert.ok(probe.ran > 0);
  assert.equal(r.status, 503); assert.equal(r.body.code, 'autoconfig_impl');
  assert.ok(!m.autotune.status().body.job);
  assert.equal(fs.readFileSync(ini, 'utf8'), before);
  assert.deepEqual(WRITES(calls), [], calls.join('\n'));
});

test('auto-tune: an autoconfig_impl refusal while planning stops the job with its own reason, not the standard-order fallback', { skip: skipWasm }, async (t) => {
  freshModules(t);
  const refusal = Object.assign(new Error('synthetic sizing refusal'), { code: 'autoconfig_impl', status: 503 });
  const { m, calls, ini } = synthetic(t, { native: 32768, inferenceBudget: { budgetGib: () => 64 }, autotuneOptions: { budgetGib: () => { throw refusal; } } });
  const before = fs.readFileSync(ini, 'utf8');
  const r = await m.autotune.start('small', TUNE);
  assert.equal(r.status, 202, 'the ladder is readable, so the run is accepted');
  const job = await tuneSettled(m);
  ran++;
  assert.equal(job.status, 'failed');
  assert.match(job.error, /synthetic sizing refusal/);
  assert.ok(!(job.log || []).some((line) => /standard tuning order/.test(JSON.stringify(line))), 'no silent fallback to the standard order');
  assert.equal(fs.readFileSync(ini, 'utf8'), before, 'the preset is untouched');
  assert.ok(!calls.includes('POST /models/load'), calls.join('\n'));
});

test('auto-tune: a planning failure that is not a refusal still falls back to the standard order (unchanged)', { skip: skipWasm }, async (t) => {
  freshModules(t);
  const { m } = synthetic(t, { native: 32768, inferenceBudget: { budgetGib: () => 64 }, autotuneOptions: { planFacts: async () => { throw new Error('model file unreadable'); } } });
  const r = await m.autotune.start('small', TUNE);
  assert.equal(r.status, 202);
  m.autotune.cancel();
  const job = await tuneSettled(m);
  ran++;
  assert.notEqual(job?.status, 'running');
  assert.ok(!/synthetic|autoconfig_impl/.test(String(job?.error || '')), String(job?.error));
});

// ---- manager: a boot-time budget fault refuses the dependent features per request --------------------------

test('manager: with a budget fault and no other budget, auto-tune refuses with the reason (503)', { skip: skipWasm }, async (t) => {
  const { m, calls, ini } = synthetic(t, { autoconfig: { budgetGib: 0, budgetFault: FAULT_REASON } });
  const before = fs.readFileSync(ini, 'utf8');
  for (const [what, call, prefix] of [
    ['autotune', () => m.autotune.start('small', { confirmPause: true, promptBudgetSeconds: 30 }), 'Auto-tune unavailable'],
  ]) {
    const r = await call();
    ran++;
    assert.equal(r.ok, false, what); assert.equal(r.status, 503, what);
    assert.equal(r.body.code, 'autoconfig_impl', what);
    assert.equal(r.body.error, `${prefix}: ${FAULT_REASON}`, what);
    assert.equal(r.body.values, undefined, `${what}: no settings are ever suggested under a fault`);
  }
  assert.equal(fs.readFileSync(ini, 'utf8'), before);
  assert.deepEqual(WRITES(calls), [], calls.join('\n'));
});

test('manager: a budget fault supplies no figure: sizing stays 0 and calibration starts from no guessed values', { skip: skipWasm }, async (t) => {
  const { m } = synthetic(t, { autoconfig: { budgetGib: 0, budgetFault: FAULT_REASON } });
  assert.equal(m.sizingBudgetGib(), 0);
  ran++;
  // Calibration measures the context, so it still starts; the start values it would take from a suggestion
  // sized against a stand-in budget are simply absent (conservativeFor is null under the fault).
  const started = await m.calibration.start('small', { confirmPause: true, promptBudgetSeconds: 30 });
  assert.equal(started.status, 202);
  await settle(m);
  ran++;
});

test('manager: a known budget makes the fault irrelevant (the inference budget, the explicit figure or the container limit)', { skip: skipWasm }, async (t) => {
  for (const [what, opts] of [
    ['inference budget', { autoconfig: { budgetGib: 0, budgetFault: FAULT_REASON }, inferenceBudget: { budgetGib: () => 64 } }],
    ['explicit figure', { autoconfig: { budgetGib: 24, explicitBudgetGib: 24, budgetFault: FAULT_REASON } }],
    ['container limit', { autoconfig: { budgetGib: 32 } }],
  ]) {
    const { m } = synthetic(t, opts);
    // The suggestion and the estimate that sized against it are the Rust front's (#2189); the
    // budget they and auto-tune use is still this one.
    ran++;
    assert.ok(m.sizingBudgetGib() > 0, what);
  }
});

test('manager: with no budget and no fault there is no sizing budget and no fault', { skip: skipWasm }, async (t) => {
  const { m } = synthetic(t, { autoconfig: { budgetGib: 0 } });
  ran++;
  assert.equal(m.sizingBudgetGib(), 0);
});

test('manager: a budget fault with a faulty evaluator still refuses every load and save', { skip: skipWasm }, async (t) => {
  const probe = faultyEvaluator(t);
  const { m, calls, ini } = synthetic(t, { autoconfig: { budgetGib: 0, budgetFault: FAULT_REASON }, inferenceBudget: { budgetGib: () => 64 } });
  const before = fs.readFileSync(ini, 'utf8');
  const load = await m.load('small');
  ran++;
  assert.equal(load.ok, false); assert.equal(load.status, 409); assert.equal(load.body.code, 'autoconfig_impl');
  const save = await m.presetRefusal('small', { 'ctx-size': '8192' });
  ran++;
  assert.equal(save.code, 'autoconfig_impl');
  assert.ok(probe.ran > 0);
  assert.equal(fs.readFileSync(ini, 'utf8'), before);
  assert.ok(!calls.includes('POST /models/load'), calls.join('\n'));
});

test('manager: the normal path (no fault) loads and saves as before', { skip: skipWasm }, async (t) => {
  const { m, calls } = synthetic(t, { autoconfig: { budgetGib: 0 }, inferenceBudget: { budgetGib: () => 64 } });
  assert.equal((await m.load('small')).ok, true);
  assert.ok(calls.includes('POST /models/load'));
  assert.equal(await m.presetRefusal('small', { 'ctx-size': '8192' }), null);
  ran++;
});
