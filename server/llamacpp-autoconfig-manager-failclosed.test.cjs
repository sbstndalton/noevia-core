'use strict';
// Manager-level fail-closed coverage for the Rust-owned sizing evaluator (#1071). When the evaluator
// entry point faults, llamacpp-manager.cjs must refuse rather than wave an unconfirmed model through:
// a load is refused (409 autoconfig_impl) before any POST /models/load, a preset save is refused and the
// .ini is untouched, the Will-it-fit panel is a 503, a suggestion carries no settings and the Models
// page shows no estimate. Only davParseWasm.llamacppAutoconfig is replaced, so the GGUF reader and the
// rest of the module stay real. Synthetic GGUF header and a fake router only: nothing is loaded.
// Needs server/wasm/dav-parse.wasm (or DAV_PARSE_WASM); skipped without it unless DAV_PARSE_WASM_REQUIRED=1.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const davParseWasm = require('./dav-parse-wasm.cjs');
const { createModelManager } = require('./model-manager.cjs');

const skipWasm = !fs.existsSync(process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built';

function gguf(kv) {
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const str = (s) => { const b = Buffer.from(s); return Buffer.concat([u64(b.length), b]); };
  const val = (type, v) => (type === 4 ? u32(v) : str(v));
  return Buffer.concat([Buffer.from('GGUF'), u32(3), u64(0), u64(Object.keys(kv).length), ...Object.entries(kv).map(([k, [t, v]]) => Buffer.concat([str(k), u32(t), val(t, v)]))]);
}
// GGUF architecture identifier and metadata-key prefix required by the format reader.
const HEADER = { 'general.architecture': [8, 'llama'], 'llama.context_length': [4, 8192], 'llama.embedding_length': [4, 4096], 'llama.block_count': [4, 32], 'llama.attention.head_count': [4, 32], 'llama.attention.head_count_kv': [4, 8], 'tokenizer.chat_template': [8, '{{ messages }}'] };

function manager(t, budget = 64) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoconfig-failclosed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'q.gguf'), gguf(HEADER));
  const ini = path.join(dir, 'models.ini');
  fs.writeFileSync(ini, 'version = 1\n\n[small]\nmodel = /models/q.gguf\nctx-size = 4096\ncache-ram = 0\n');
  const calls = [], state = { small: 'unloaded' };
  const m = createModelManager({ kind: 'llamacpp', baseUrl: 'http://synthetic', presetPath: ini, autoconfig: { modelsPath: dir, cacheRamMaxMib: 1024 }, gate: require('./fixtures/fake-inference-gate.cjs').fakeGate(),
    inferenceBudget: { budgetGib: () => budget },
    fetchJson: async (url, options = {}) => {
      const p = new URL(url).pathname;
      calls.push(`${options.method || 'GET'} ${p}`);
      if (p === '/models/load') state.small = 'loaded';
      return { ok: true, status: 200, body: p === '/models' ? { data: [{ id: 'small', status: { value: state.small } }] } : { success: true } };
    } });
  return { m, calls, ini };
}

// Replaces only the evaluator entry point (every caller must reach it; there is no opt-out). `ran` counts the guarded bodies that actually executed, so a
// test cannot pass because the fault was never reached; test.after asserts it.
function faultyEvaluator(t) {
  const saved = davParseWasm.llamacppAutoconfig, probe = { ran: 0 };
  davParseWasm.llamacppAutoconfig = () => { probe.ran++; throw new davParseWasm.DavParseError('synthetic evaluator fault', 'trap'); };
  const warn = console.warn; console.warn = () => {};
  t.after(() => {
    console.warn = warn;
    davParseWasm.llamacppAutoconfig = saved;
    assert.ok(probe.ran > 0, 'the guarded sizing body must have reached the faulty evaluator');
  });
  return probe;
}

test('control: with the real evaluator the small model loads and the fake router sees POST /models/load', { skip: skipWasm }, async (t) => {
  const { m, calls } = manager(t);
  assert.equal((await m.load('small')).ok, true);
  assert.ok(calls.includes('POST /models/load'), calls.join('\n'));
});

test('manager: a faulty evaluator refuses the load with 409 autoconfig_impl and never posts /models/load', { skip: skipWasm }, async (t) => {
  const probe = faultyEvaluator(t);
  const { m, calls } = manager(t);
  const r = await m.load('small');
  assert.ok(probe.ran > 0);
  assert.equal(r.ok, false); assert.equal(r.status, 409); assert.equal(r.body.code, 'autoconfig_impl');
  assert.match(r.body.error, /^small was not loaded: the memory estimate \(load footprint\) could not be confirmed/);
  assert.ok(!calls.includes('POST /models/load'), calls.join('\n'));
});

test('manager: a faulty evaluator refuses a preset save, leaving the ini untouched', { skip: skipWasm }, async (t) => {
  const probe = faultyEvaluator(t);
  const { m, ini, calls } = manager(t);
  const before = fs.readFileSync(ini, 'utf8');
  const refusal = await m.presetRefusal('small', { 'ctx-size': '8192' });
  assert.ok(probe.ran > 0);
  assert.equal(refusal.code, 'autoconfig_impl'); assert.match(refusal.error, /^Not saved: /);
  const rev = (await m.getPreset('small')).body.revision;
  const saved = await m.applyPreset({ model: 'small', baseRevision: rev, confirmReload: true, options: { 'ctx-size': '8192' } });
  assert.equal(saved.status, 409); assert.equal(saved.body.code, 'autoconfig_impl');
  assert.equal(fs.readFileSync(ini, 'utf8'), before);
  assert.ok(!calls.includes('POST /models/load'), calls.join('\n'));
});

// The Will-it-fit panel and the preset suggestion are the Rust front's since #2189 (noevia-rs
// model_sizing.rs, which links the sizing port instead of loading this module).
