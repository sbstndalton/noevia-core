'use strict';
// LLAMACPP_AUTOCONFIG_IMPL (js|wasm): the switch's reading, and every path where the Rust port
// refuses, faults or disagrees, with stand-in ports (no WebAssembly needed). The JS answer is
// returned only when the port agrees byte for byte or the JS answer is the conservative one;
// otherwise suggest offers no settings and the estimates refuse the load or save. Then the model
// manager under wasm with an unusable module: loads, preset saves and the Will-it-fit panel refuse
// instead of passing unconfirmed. Synthetic GGUF headers and a fake router only: nothing is loaded.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const ac = require('./llamacpp-autoconfig.cjs');
const davParseWasm = require('./dav-parse-wasm.cjs');
const { createModelManager } = require('./model-manager.cjs');

const GIB = 1024 ** 3;
const meta = { arch: 'qwen35', contextLength: 262144, embeddingLength: 4096, blockCount: 32, headCount: 16, headCountKv: 4, keyLength: 256, valueLength: 256, fullAttentionInterval: 4, hasChatTemplate: true };
const SUGGEST = { meta, modelBytes: 5.56 * GIB, mmprojBytes: 0.86 * GIB, budgetGib: 14, current: { 'ubatch-size': '1024' } };
const FOOT = { meta, modelBytes: 5.56 * GIB, options: { 'ctx-size': '65536', 'cache-type-k': 'q8_0', 'cache-type-v': 'q8_0', 'cache-ram': '1024' }, model: 'm' };
const INPUTS = { meta, modelBytes: 5.56 * GIB, current: { 'cache-ram': '1024' } };

function capture(fn) {
  const warn = console.warn, lines = [];
  console.warn = (...a) => lines.push(a.join(' '));
  try { return { value: fn(), lines }; } finally { console.warn = warn; }
}
const reply = (value) => () => ({ llamacppAutoconfig: () => ({ text: JSON.stringify(value), reply: value }) });
const faulty = (reason) => () => ({ llamacppAutoconfig: () => { throw Object.assign(Error('refused'), { reason }); } });
const wasm = (wasmLoader) => ({ impl: 'wasm', wasmLoader });

test('LLAMACPP_AUTOCONFIG_IMPL: js by default, wasm when set, anything else js with one warning', () => {
  assert.equal(ac.autoconfigImpl({}), 'js');
  assert.equal(ac.autoconfigImpl({ LLAMACPP_AUTOCONFIG_IMPL: '' }), 'js');
  assert.equal(ac.autoconfigImpl({ LLAMACPP_AUTOCONFIG_IMPL: ' WASM ' }), 'wasm');
  const { lines } = capture(() => { ac.autoconfigImpl({ LLAMACPP_AUTOCONFIG_IMPL: 'rust' }); ac.autoconfigImpl({ LLAMACPP_AUTOCONFIG_IMPL: 'rust' }); });
  assert.equal(lines.length, 1); assert.match(lines[0], /LLAMACPP_AUTOCONFIG_IMPL="rust" is not js or wasm; using js/);
  // js never asks the port, whatever the module would say.
  const never = () => { throw Error('asked'); };
  assert.deepEqual(ac.suggest(SUGGEST, { env: {}, wasmLoader: never }), ac.suggestJs(SUGGEST));
  assert.deepEqual(ac.estimateFootprint(FOOT, { env: { LLAMACPP_AUTOCONFIG_IMPL: 'js' }, wasmLoader: never }), ac.estimateFootprintJs(FOOT));
  assert.equal(ac.suggest(SUGGEST, { env: { LLAMACPP_AUTOCONFIG_IMPL: 'wasm' }, wasmLoader: reply(ac.suggestJs(SUGGEST)) }).values['ctx-size'], ac.suggestJs(SUGGEST).values['ctx-size']);
});

test('an agreeing port: the JS answer, unchanged and unlogged', () => {
  for (const [fn, jsFn, args] of [[ac.suggest, ac.suggestJs, SUGGEST], [ac.estimateFootprint, ac.estimateFootprintJs, FOOT], [ac.estimateInputs, ac.estimateInputsJs, INPUTS]]) {
    const js = jsFn(args);
    const { value, lines } = capture(() => fn(args, wasm(reply(js))));
    assert.deepEqual(value, js); assert.equal(lines.length, 0);
  }
});

test('suggest: a port that refuses or faults withholds JS settings, but a JS error passes', () => {
  const { value, lines } = capture(() => ac.suggest(SUGGEST, wasm(faulty('trap'))));
  assert.equal(value.code, 'autoconfig_impl'); assert.equal(value.values, undefined); assert.equal(value.unverified, 'impl_refused');
  assert.match(value.error, /LLAMACPP_AUTOCONFIG_IMPL=wasm/);
  assert.equal(lines.length, 1); assert.match(lines[0], /suggest\.wasm_refused \(trap; refused\)/);
  // Logged once per reason.
  assert.equal(capture(() => ac.suggest(SUGGEST, wasm(faulty('trap')))).lines.length, 0);
  const noBudget = { ...SUGGEST, budgetGib: 0 };
  assert.deepEqual(capture(() => ac.suggest(noBudget, wasm(faulty('ambiguous')))).value, ac.suggestJs(noBudget));
});

test('suggest: a disagreeing port lets the JS through only when every JS knob is no larger', () => {
  const js = ac.suggestJs(SUGGEST);
  const bump = (k, v) => ({ ...js, values: { ...js.values, [k]: v } });
  // The port would offer more: the JS (smaller) stands, logged.
  for (const [k, v] of [['ctx-size', '262144'], ['cache-ram', '2048'], ['ubatch-size', '4096']]) {
    const { value, lines } = capture(() => ac.suggest(SUGGEST, wasm(reply(bump(k, v)))));
    assert.deepEqual(value, js, k); assert.ok(lines.some((l) => /impl_mismatch.*conservative/.test(l)) || lines.length === 0);
  }
  // The port would offer less, a different cache type, an extra or a missing knob, or no settings.
  const noKnob = { ...js, values: { ...js.values } }; delete noKnob.values['image-max-tokens'];
  for (const port of [bump('ctx-size', '4096'), bump('cache-ram', '256'), bump('cache-type-k', 'f16'), bump('spec-type', 'draft-mtp'), bump('threads', '8'), noKnob, { error: 'x' }, null, 'junk']) {
    const r = capture(() => ac.suggest(SUGGEST, wasm(reply(port)))).value;
    assert.equal(r.code, 'autoconfig_impl', JSON.stringify(port)?.slice(0, 80)); assert.equal(r.values, undefined);
  }
});

test('estimateFootprint: a refused or smaller-than-JS port answer keeps the JS; a larger one refuses', () => {
  const js = ac.estimateFootprintJs(FOOT);
  assert.ok(js.totalGib > 0 && !js.cacheRamUnbounded);
  const bigger = { ...js, totalGib: js.totalGib + 0.01 }, smaller = { ...js, totalGib: js.totalGib - 0.01 };
  assert.deepEqual(capture(() => ac.estimateFootprint(FOOT, wasm(reply(smaller)))).value, js);
  for (const port of [bigger, { ...js, cacheRamUnbounded: true, totalGib: null, cacheRamGib: null }, { ...smaller, sizeable: false, kvGib: 0 }]) {
    assert.throws(() => capture(() => ac.estimateFootprint(FOOT, wasm(reply(port)))), (e) => e instanceof ac.AutoconfigImplError && e.code === 'autoconfig_impl' && e.status === 503);
  }
  assert.throws(() => capture(() => ac.estimateFootprint(FOOT, wasm(faulty('missing')))), (e) => e.code === 'autoconfig_impl');
  // A JS estimate that refuses any load stands whatever the port says.
  const open = { ...FOOT, options: { ...FOOT.options, 'cache-ram': '-1' } };
  assert.deepEqual(capture(() => ac.estimateFootprint(open, wasm(faulty('trap')))).value, ac.estimateFootprintJs(open));
  // The JS throws: the port is not asked.
  let asked = false;
  assert.throws(() => ac.estimateFootprint({ ...FOOT, options: null }, wasm(() => { asked = true; return {}; })), TypeError);
  assert.equal(asked, false);
});

test('estimateInputs: JS figures at least the port\'s stand; anything else refuses', () => {
  const js = ac.estimateInputsJs(INPUTS);
  const lower = { ...js, modelGib: js.modelGib - 0.5, rows: js.rows.map((r) => ({ ...r, kvQ8Gib: r.kvQ8Gib / 2 })) };
  assert.deepEqual(capture(() => ac.estimateInputs(INPUTS, wasm(reply(lower)))).value, js);
  // noevia#1134: lower figures do not excuse different facts.
  for (const port of [{ ...lower, moe: !js.moe }, { ...lower, chat: !js.chat }, { ...lower, nativeCtx: 4096 }, { ...lower, current: { ...js.current, ctx: 8192 } },
    { ...lower, current: { ...js.current, kv: 'q4_0' } }, { ...lower, current: null }]) {
    assert.throws(() => capture(() => ac.estimateInputs(INPUTS, wasm(reply(port)))), (e) => e.code === 'autoconfig_impl', JSON.stringify(port).slice(0, 60));
  }
  for (const port of [{ ...js, pinnedGib: js.pinnedGib + 1 }, { ...js, rows: js.rows.slice(1) }, { ...js, cacheRamGib: 99 }, { ...js, rows: js.rows.map((r) => ({ ...r, kvQ8Gib: r.kvQ8Gib + 1 })) }]) {
    assert.throws(() => capture(() => ac.estimateInputs(INPUTS, wasm(reply(port)))), (e) => e.code === 'autoconfig_impl');
  }
  assert.throws(() => capture(() => ac.estimateInputs(INPUTS, wasm(faulty('trap')))), (e) => e.code === 'autoconfig_impl');
});

test('property: whatever the port answers, the switched suggestion is the JS one or none', () => {
  let x = 0x5eed;
  const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
  for (let i = 0; i < 300; i++) {
    const args = { ...SUGGEST, budgetGib: 4 + rnd() * 30, modelBytes: (1 + rnd() * 10) * GIB, cacheRamMaxMib: Math.floor(rnd() * 3000) };
    const js = ac.suggestJs(args);
    const port = js.values ? { ...js, values: Object.fromEntries(Object.entries(js.values).map(([k, v]) => [k, /^\d+$/.test(v) && rnd() < 0.5 ? String(Math.floor(Number(v) * (0.5 + rnd()))) : v])) } : js;
    const got = capture(() => ac.suggest(args, wasm(reply(port)))).value;
    if (got.values) {
      assert.deepEqual(got, js);
      for (const [k, v] of Object.entries(got.values)) if (/^\d+$/.test(v)) assert.ok(Number(v) <= Number(js.values[k]), k);
    } else if (js.values) assert.equal(got.code, 'autoconfig_impl');
  }
});

// ── llamacpp-manager.cjs under wasm with an unusable module ─────────────────────────────────

function gguf(kv) {
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const str = (s) => { const b = Buffer.from(s); return Buffer.concat([u64(b.length), b]); };
  const val = (type, v) => (type === 4 ? u32(v) : str(v));
  return Buffer.concat([Buffer.from('GGUF'), u32(3), u64(0), u64(Object.keys(kv).length), ...Object.entries(kv).map(([k, [t, v]]) => Buffer.concat([str(k), u32(t), val(t, v)]))]);
}
const qwen35 = { 'general.architecture': [8, 'qwen35'], 'qwen35.context_length': [4, 262144], 'qwen35.embedding_length': [4, 4096], 'qwen35.block_count': [4, 32], 'qwen35.attention.head_count': [4, 16], 'qwen35.attention.head_count_kv': [4, 4], 'qwen35.attention.key_length': [4, 256], 'qwen35.attention.value_length': [4, 256], 'qwen35.full_attention_interval': [4, 4], 'tokenizer.chat_template': [8, '{{ messages }}'] };

function manager(t, budget = 64) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoconfig-impl-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'q.gguf'), gguf(qwen35));
  const ini = path.join(dir, 'models.ini');
  fs.writeFileSync(ini, 'version = 1\n\n[small]\nmodel = /models/q.gguf\nctx-size = 4096\ncache-ram = 0\n');
  const calls = [], state = { small: 'unloaded' };
  const m = createModelManager({ kind: 'llamacpp', baseUrl: 'http://synthetic', presetPath: ini, autoconfig: { modelsPath: dir, cacheRamMaxMib: 1024 },
    inferenceBudget: { budgetGib: () => budget },
    fetchJson: async (url, options = {}) => {
      const p = new URL(url).pathname;
      calls.push(`${options.method || 'GET'} ${p}`);
      if (p === '/models/load') state.small = 'loaded';
      return { ok: true, status: 200, body: p === '/models' ? { data: [{ id: 'small', status: { value: state.small } }] } : { success: true } };
    } });
  return { m, calls, ini };
}

function withUnusableModule(t) {
  const saved = { impl: process.env.LLAMACPP_AUTOCONFIG_IMPL, file: process.env.DAV_PARSE_WASM };
  process.env.LLAMACPP_AUTOCONFIG_IMPL = 'wasm';
  process.env.DAV_PARSE_WASM = path.join(os.tmpdir(), 'no-such-dav-parse.wasm');
  davParseWasm.reset();
  const warn = console.warn; console.warn = () => {};
  t.after(() => {
    console.warn = warn;
    for (const [k, v] of [['LLAMACPP_AUTOCONFIG_IMPL', saved.impl], ['DAV_PARSE_WASM', saved.file]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    davParseWasm.reset();
  });
}

test('manager: under js the small model loads; under wasm with no usable module the load is refused, not waved through', async (t) => {
  const js = manager(t);
  assert.equal((await js.m.load('small')).ok, true);
  withUnusableModule(t);
  const { m, calls } = manager(t);
  const r = await m.load('small');
  assert.equal(r.ok, false); assert.equal(r.status, 409); assert.equal(r.body.code, 'autoconfig_impl');
  assert.match(r.body.error, /^small was not loaded: the memory estimate \(load footprint\) could not be confirmed/);
  assert.ok(!calls.includes('POST /models/load'), calls.join('\n'));
});

test('manager: under wasm with no usable module a preset save is refused, the panel is a 503 and no settings are suggested', async (t) => {
  withUnusableModule(t);
  const { m, ini } = manager(t);
  const before = fs.readFileSync(ini, 'utf8');
  const refusal = await m.presetRefusal('small', { 'ctx-size': '8192' });
  assert.equal(refusal.code, 'autoconfig_impl'); assert.match(refusal.error, /^Not saved: /);
  const rev = (await m.getPreset('small')).body.revision;
  const saved = await m.applyPreset({ model: 'small', baseRevision: rev, confirmReload: true, options: { 'ctx-size': '8192' } });
  assert.equal(saved.status, 409); assert.equal(saved.body.code, 'autoconfig_impl');
  assert.equal(fs.readFileSync(ini, 'utf8'), before);
  const panel = await m.estimateMemory('small');
  assert.equal(panel.status, 503); assert.equal(panel.body.code, 'autoconfig_impl');
  const s = await m.suggestPreset('small');
  assert.equal(s.status, 200); assert.equal(s.body.code, 'autoconfig_impl'); assert.equal(s.body.values, undefined);
  // The Models page shows no estimate rather than a wrong one.
  const est = await m.inferenceEstimates();
  assert.equal(est.body.models[0].estimate, null); assert.equal(est.body.models[0].fits, null);
});
