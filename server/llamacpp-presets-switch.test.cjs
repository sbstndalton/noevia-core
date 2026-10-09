'use strict';
// LLAMACPP_PRESETS_IMPL with a stand-in port: the switch's reading, and that the port can only
// make prepare() and canonicalOptions() refuse more (a mismatch, a fault or an undecided answer
// refuses with the caller's existing 400), never accept or write more. All presets are synthetic.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const presets = require('./llamacpp-presets.cjs');

const LIMITS = { capMib: 1024, hardMaxMib: 2048 };
const WASM = { LLAMACPP_PRESETS_IMPL: 'wasm' };

function quietly(fn) {
  const warn = console.warn, seen = [];
  console.warn = (m) => seen.push(String(m));
  try { return { value: fn(), seen }; } finally { console.warn = warn; }
}
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'presets-switch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'models.ini');
  fs.writeFileSync(file, '[*]\nbatch-size = 2048\n\n[synthetic]\nmodel = /models/synthetic.gguf\nub = 512\n');
  return file;
}
/** A port that answers as the JS does, with `over` replacing any of its calls. */
function standIn(over = {}, calls = []) {
  const port = {
    llamacppPresetsModel: (m) => ({ ok: presets.modelNameOk(m) }),
    llamacppPresetsValues: (pairs, hard) => ({ values: pairs.map(([k, v]) => presets.optionValue(k, v, { hardMaxMib: hard }) ?? null) }),
    llamacppPresetsBatch: (u, b) => ({ exceeds: presets.microBatchExceeds(u ?? undefined, b ?? undefined) }),
    llamacppPresetsCanonical: (pairs) => ({ options: pairs.map((p) => presets.canonicalEntry(...p)) }),
  };
  for (const k of Object.keys(port)) {
    const f = over[k] || port[k];
    port[k] = (...a) => { calls.push(k); return f(...a); };
  }
  return () => port;
}
const store = (file, env, loader) => presets.createPresetStore(file, { cacheRam: LIMITS, env, wasmLoader: loader });
const body = (file, options, model = 'synthetic') => ({ model, baseRevision: store(file, {}).get('synthetic').revision, options });

test('LLAMACPP_PRESETS_IMPL: js by default, wasm read trimmed and case-folded, anything else js with one warning', () => {
  assert.equal(presets.llamacppPresetsImpl({}), 'js');
  assert.equal(presets.llamacppPresetsImpl({ LLAMACPP_PRESETS_IMPL: '' }), 'js');
  assert.equal(presets.llamacppPresetsImpl({ LLAMACPP_PRESETS_IMPL: ' WASM ' }), 'wasm');
  const r = quietly(() => [presets.llamacppPresetsImpl({ LLAMACPP_PRESETS_IMPL: 'rust' }), presets.llamacppPresetsImpl({ LLAMACPP_PRESETS_IMPL: 'rust' })]);
  assert.deepEqual(r.value, ['js', 'js']);
  assert.equal(r.seen.length, 1);
  assert.match(r.seen[0], /LLAMACPP_PRESETS_IMPL="rust" is not js or wasm; using js/);
});

test('js never asks the port; an agreeing port writes exactly the JS text', (t) => {
  const file = fixture(t), calls = [];
  const options = { 'ctx-size': '8192', 'cache-ram': ' 0700 ', temp: '0.7' };
  const js = store(file, {}, standIn({}, calls)).prepare(body(file, options));
  assert.deepEqual(calls, []);
  const sw = store(file, WASM, standIn({}, calls)).prepare(body(file, options));
  assert.equal(sw.text, js.text);
  assert.match(sw.text, /cache-ram = 700/);
  assert.deepEqual(calls, ['llamacppPresetsModel', 'llamacppPresetsValues', 'llamacppPresetsBatch']);
});

test('a value the port does not accept identically is refused with the existing 400, naming the option', (t) => {
  const file = fixture(t);
  for (const values of [
    (pairs) => ({ values: pairs.map(([k, v]) => (k === 'temp' ? null : presets.optionValue(k, v, LIMITS))) }),
    (pairs) => ({ values: pairs.map(([k, v]) => (k === 'temp' ? '0.70' : presets.optionValue(k, v, LIMITS))) }),
  ]) {
    const r = quietly(() => assert.throws(() => store(file, WASM, standIn({ llamacppPresetsValues: values })).prepare(body(file, { 'ctx-size': '8192', temp: '0.7' })),
      { status: 400, message: 'Invalid preset option: temp' }));
    assert.ok(r.seen.every((l) => !l.includes('0.7')), 'warnings carry no value');
  }
  // A clamped cache-ram the port clamps differently is refused too.
  quietly(() => assert.throws(() => store(file, WASM, standIn({ llamacppPresetsValues: () => ({ values: ['4096'] }) })).prepare(body(file, { 'cache-ram': '-1' })),
    { status: 400, message: 'Invalid preset option: cache-ram' }));
});

test('a port fault refuses (400) with one warning per reason, and never more than the JS', (t) => {
  const file = fixture(t);
  const fault = () => { throw Object.assign(new Error('synthetic'), { reason: 'trap' }); };
  for (const [name, message] of [['llamacppPresetsModel', 'Invalid preset model name'], ['llamacppPresetsValues', 'Invalid preset option: parallel'], ['llamacppPresetsBatch', 'Invalid preset option: ubatch-size']]) {
    const r = quietly(() => {
      for (let i = 0; i < 2; i++) assert.throws(() => store(file, WASM, standIn({ [name]: fault })).prepare(body(file, { parallel: '2' })), { status: 400, message });
    });
    assert.ok(r.seen.length <= 1, r.seen.join('\n'));
  }
  // What the JS refuses stays refused whatever the port says.
  const yes = standIn({ llamacppPresetsValues: (pairs) => ({ values: pairs.map(([, v]) => v) }), llamacppPresetsModel: () => ({ ok: true }) });
  assert.throws(() => store(file, WASM, yes).prepare(body(file, { parallel: '1000' })), { status: 400, message: 'Invalid preset option: parallel' });
  assert.throws(() => store(file, WASM, yes).prepare(body(file, { model: '/evil' })), { status: 400 });
  assert.throws(() => store(file, WASM, yes).prepare(body(file, { parallel: '2' }, 'a b')), { status: 400, message: 'Invalid preset model name' });
});

test('the micro-batch check: the port saying it exceeds, or not deciding, refuses', (t) => {
  const file = fixture(t);
  quietly(() => {
    assert.throws(() => store(file, WASM, standIn({ llamacppPresetsBatch: () => ({ exceeds: true }) })).prepare(body(file, { 'ubatch-size': '64' })),
      { status: 400, message: 'Micro batch cannot exceed batch size' });
    assert.throws(() => store(file, WASM, standIn({ llamacppPresetsBatch: () => ({ exceeds: null }) })).prepare(body(file, { 'ubatch-size': '64' })),
      { status: 400, message: 'Invalid preset option: ubatch-size' });
  });
  // The JS refusal comes first and the port is not needed for it.
  assert.throws(() => store(file, WASM, standIn({ llamacppPresetsBatch: () => ({ exceeds: false }) })).prepare(body(file, { 'ubatch-size': '4096', 'batch-size': '1024' })),
    { status: 400, message: 'Micro batch cannot exceed batch size' });
});

test('a model name that is not a string is refused under js and wasm alike (noevia#1231)', (t) => {
  const file = fixture(t);
  for (const model of [123, ['synthetic']]) {
    for (const impl of [{}, WASM]) {
      assert.throws(() => store(file, impl, standIn()).prepare(body(file, { parallel: '2' }, model)), { status: 400, message: 'Invalid preset model name' });
    }
  }
});

test('checkedCanonicalOptions: agreement returns the JS options; a different fold or a fault names the entry', () => {
  const options = { '--cram': ' 512 ', c: 4096, model: '/m.gguf', np: null };
  const js = presets.canonicalOptions(options);
  assert.deepEqual(presets.checkedCanonicalOptions(options, { env: {} }), { options: js, refused: null });
  assert.deepEqual(presets.checkedCanonicalOptions(options, { env: WASM, wasmLoader: standIn() }), { options: js, refused: null });
  const other = standIn({ llamacppPresetsCanonical: (pairs) => ({ options: pairs.map((p, i) => (i === 2 ? ['ctx-size', '/m.gguf'] : presets.canonicalEntry(...p))) }) });
  assert.equal(quietly(() => presets.checkedCanonicalOptions(options, { env: WASM, wasmLoader: other })).value.refused, 'model');
  const value = standIn({ llamacppPresetsCanonical: (pairs) => ({ options: pairs.map((p, i) => (i === 0 ? ['cache-ram', ' 512 '] : presets.canonicalEntry(...p))) }) });
  assert.equal(quietly(() => presets.checkedCanonicalOptions(options, { env: WASM, wasmLoader: value })).value.refused, '--cram');
  const fault = standIn({ llamacppPresetsCanonical: () => { throw new Error('synthetic'); } });
  assert.equal(quietly(() => presets.checkedCanonicalOptions(options, { env: WASM, wasmLoader: fault })).value.refused, '--cram');
  assert.deepEqual(presets.checkedCanonicalOptions({}, { env: WASM, wasmLoader: fault }), { options: {}, refused: null });
});

test("presetRefusal (the model manager's section save) refuses an entry the port folds differently with a 400 invalid_size", async (t) => {
  const file = fixture(t);
  const wasmPath = require.resolve('./dav-parse-wasm.cjs');
  const saved = require.cache[wasmPath], env = process.env.LLAMACPP_PRESETS_IMPL;
  const port = standIn({ llamacppPresetsCanonical: (pairs) => ({ options: pairs.map(([k, v]) => [k === 'c' ? null : presets.canonicalEntry(k, v)[0], v === null ? null : v.trim()]) }) })();
  require.cache[wasmPath] = { id: wasmPath, filename: wasmPath, loaded: true, exports: port };
  process.env.LLAMACPP_PRESETS_IMPL = 'wasm';
  t.after(() => {
    if (saved) require.cache[wasmPath] = saved; else delete require.cache[wasmPath];
    if (env === undefined) delete process.env.LLAMACPP_PRESETS_IMPL; else process.env.LLAMACPP_PRESETS_IMPL = env;
  });
  const { createLlamaCppManager } = require('./llamacpp-manager.cjs');
  const manager = createLlamaCppManager({ baseUrl: 'http://synthetic', presetPath: file, fetchJson: async () => ({ ok: true, status: 200, body: { data: [] } }) });
  const refusal = await quietly(() => manager.presetRefusal('synthetic', { c: '1048576', parallel: '1' })).value;
  assert.equal(refusal.code, 'invalid_size');
  assert.match(refusal.error, /^Not saved: the preset option "c" could not be checked\.$/);
  assert.equal(await manager.presetRefusal('synthetic', { parallel: '1' }), null);
});
