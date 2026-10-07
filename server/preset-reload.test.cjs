'use strict';
// #1012: a router preset reload may keep loaded models only behind PRESET_RELOAD_IMPL=wasm, the
// maintenance gate, a recorded router view and Rust's safe check. Synthetic presets only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createReloadGuard, engineView } = require('./preset-reload.cjs');
const { createLlamaCppManager } = require('./llamacpp-manager.cjs');
const davParseWasm = require('./dav-parse-wasm.cjs');

const wasmFile = process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM;
const skipWasm = !fs.existsSync(wasmFile) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built';

const BASE = 'version = 1\n[*]\ncache-ram = 1024\n[loaded-model]\nmodel = /models/a.gguf\nctx-size = 8192\n[other]\nmodel = /models/b.gguf\n';
const WASM = { PRESET_RELOAD_IMPL: 'wasm' };

// A stand-in for the Rust check in the unit tests: the loaded sections and [*] must be identical.
function sectionOf(text, name) { const m = new RegExp(`^\\[${name.replace(/[*.-]/g, '\\$&')}\\]\\n([^[]*)`, 'm').exec(text); return m ? m[1] : null; }
function fakeCheck({ baseline, current, loaded }) {
  const changed = loaded.filter((id) => sectionOf(baseline, '*') !== sectionOf(current, '*') || sectionOf(baseline, id) !== sectionOf(current, id));
  return { safe: !changed.length, reason: changed.length ? 'changed' : 'unchanged', changed, detail: null };
}

function tmp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preset-reload-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
const rows = (loaded, presets = {}) => ['loaded-model', 'other'].map((id) => ({ id, status: { value: loaded.includes(id) ? 'loaded' : 'unloaded', preset: presets[id] ?? `[${id}]` } }));

test('#1012 guard: off by default, unknown without a baseline, and fails closed on a moved router or a failed check', (t) => {
  const off = createReloadGuard({ env: {}, check: fakeCheck });
  off.record(BASE, rows([]), BASE);
  assert.deepEqual(off.verdict(BASE, rows([]), ['loaded-model']), { safe: false, reason: 'off' });

  const g = createReloadGuard({ env: WASM, check: fakeCheck });
  assert.equal(g.verdict(BASE, rows([]), ['loaded-model']).reason, 'unknown');
  g.record(BASE, rows([]), BASE);
  assert.equal(g.verdict(BASE + '[new]\nmodel = /models/n.gguf\n', rows(['loaded-model']), ['loaded-model']).safe, true, 'load state alone is not a router change');
  assert.equal(g.verdict(BASE, rows([], { other: '[other]\nctx-size = 1' }), ['loaded-model']).reason, 'engine_moved');
  assert.equal(g.verdict(null, rows([]), ['loaded-model']).reason, 'unreadable');
  assert.deepEqual(g.verdict(BASE.replace('8192', '4096'), rows([]), ['loaded-model']), { safe: false, reason: 'changed', changed: ['loaded-model'] });
  const throwing = createReloadGuard({ env: WASM, check: () => { throw new Error('trap'); } });
  throwing.record(BASE, rows([]), BASE);
  assert.equal(throwing.verdict(BASE, rows([]), ['loaded-model']).reason, 'check_failed');
  // A file that moved while the router reloaded leaves the baseline unknown.
  g.record(BASE, rows([]), BASE + '\n[x]\n');
  assert.equal(g.verdict(BASE, rows([]), ['loaded-model']).reason, 'unknown');
});

test('#1012 guard: the baseline survives a core restart and forget() removes it', (t) => {
  const stateFile = path.join(tmp(t), 'state.json');
  const a = createReloadGuard({ stateFile, env: WASM, check: fakeCheck });
  a.record(BASE, rows([]), BASE);
  assert.equal((fs.statSync(stateFile).mode & 0o777), 0o600);
  const b = createReloadGuard({ stateFile, env: WASM, check: fakeCheck });
  assert.equal(b.known(), true);
  assert.equal(b.verdict(BASE, rows([]), ['loaded-model']).safe, true);
  b.forget();
  assert.equal(fs.existsSync(stateFile), false);
  fs.writeFileSync(stateFile, '{not json');
  assert.equal(createReloadGuard({ stateFile, env: WASM, check: fakeCheck }).known(), false);
});

test('#1012 engineView is order-independent and sees preset changes and new or removed models', () => {
  const r = rows([]);
  assert.equal(engineView(r), engineView([...r].reverse()));
  assert.notEqual(engineView(r), engineView(rows([], { other: '[other]\nx = 1' })));
  assert.notEqual(engineView(r), engineView(r.slice(1)));
});

function managerFixture(t, env) {
  const dir = tmp(t);
  const file = path.join(dir, 'models.ini');
  fs.writeFileSync(file, BASE);
  const state = { loaded: [], calls: [], presets: {} };
  const fetchJson = async (url, opts = {}) => {
    const u = new URL(url);
    state.calls.push(`${opts.method || 'GET'} ${u.pathname}${u.search}`);
    if (u.pathname === '/models/unload') { const id = JSON.parse(opts.body).model; state.loaded = state.loaded.filter((x) => x !== id); return { ok: true, status: 200, body: { success: true } }; }
    return { ok: true, status: 200, body: { data: rows(state.loaded, state.presets) } };
  };
  const reloadGuard = createReloadGuard({ env, check: fakeCheck, stateFile: path.join(dir, 'reload.json') });
  const manager = createLlamaCppManager({ baseUrl: 'http://synthetic', presetPath: file, fetchJson, reloadGuard });
  return { file, state, manager, reloads: () => state.calls.filter((c) => c === 'GET /models?reload=1').length };
}

test('#1012 with the flag on, a new section is served without unloading the loaded model', async (t) => {
  const f = managerFixture(t, WASM);
  assert.equal((await f.manager.reloadPresets()).status, 200, 'nothing loaded: reload and record');
  f.state.loaded = ['loaded-model'];
  fs.appendFileSync(f.file, '[gemma-synthetic]\nmodel = /models/g.gguf\nctx-size = 8192\n');
  const r = await f.manager.reloadPresets();
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { reloaded: true, unloaded: [], kept: ['loaded-model'] });
  assert.equal(f.reloads(), 2);
  assert.ok(!f.state.calls.includes('POST /models/unload'));
  assert.deepEqual(f.state.loaded, ['loaded-model']);
});

test('#1012 with the flag on, an edit to the loaded model, an unknown baseline or a moved router still refuses', async (t) => {
  const f = managerFixture(t, WASM);
  f.state.loaded = ['loaded-model'];
  assert.equal((await f.manager.reloadPresets()).body.reason, 'unknown', 'no baseline yet');
  f.state.loaded = [];
  await f.manager.reloadPresets();
  f.state.loaded = ['loaded-model'];
  fs.writeFileSync(f.file, BASE.replace('ctx-size = 8192', 'ctx-size = 16384'));
  const changed = await f.manager.reloadPresets();
  assert.equal(changed.status, 409); assert.equal(changed.body.reason, 'changed'); assert.deepEqual(changed.body.loaded, ['loaded-model']);
  fs.writeFileSync(f.file, BASE);
  f.state.presets = { other: '[other]\nmodel = /models/elsewhere.gguf' };
  assert.equal((await f.manager.reloadPresets()).body.reason, 'engine_moved');
  assert.equal(f.reloads(), 1, 'no refused attempt reached the router');
  // Asked to unload, it still unloads first, then reloads (unchanged behaviour).
  const forced = await f.manager.reloadPresets({ unload: true });
  assert.deepEqual(forced.body, { reloaded: true, unloaded: ['loaded-model'] });
});

test('#1012 never during a chat or a held gate (auto-tune, calibration)', async (t) => {
  const f = managerFixture(t, WASM);
  await f.manager.reloadPresets();
  f.state.loaded = ['loaded-model'];
  const leave = f.manager.enterInference();
  await assert.rejects(f.manager.reloadPresets(), { status: 409 });
  leave();
  const release = f.manager.holdMaintenance('synthetic tune');
  await assert.rejects(f.manager.reloadPresets(), { status: 409 });
  release();
  assert.equal(f.reloads(), 1);
});

test('#1012 with the flag off, behaviour is exactly as before: refuse while loaded, no reason field', async (t) => {
  const f = managerFixture(t, {});
  await f.manager.reloadPresets();
  f.state.loaded = ['loaded-model'];
  fs.appendFileSync(f.file, '[new]\nmodel = /models/n.gguf\n');
  const r = await f.manager.reloadPresets();
  assert.equal(r.status, 409);
  assert.deepEqual(r.body, { error: 'A model is loaded. Unload it to apply the new settings.', loaded: ['loaded-model'] });
});

test('#1012 a failed router reload forgets the baseline', async (t) => {
  const f = managerFixture(t, WASM);
  await f.manager.reloadPresets();
  const failing = createLlamaCppManager({ baseUrl: 'http://synthetic', presetPath: f.file, reloadGuard: createReloadGuard({ env: WASM, check: fakeCheck }),
    fetchJson: async (url) => (url.includes('reload=1') ? { ok: false, status: 500, body: {} } : { ok: true, status: 200, body: { data: rows([]) } }) });
  assert.equal((await failing.reloadPresets()).status, 502);
});

test('#1012 dav-parse.wasm preset_reload: the real Rust check', { skip: skipWasm }, () => {
  davParseWasm.reset();
  const add = davParseWasm.presetReload({ baseline: BASE, current: BASE + '[new]\nmodel = /models/n.gguf\n', loaded: ['loaded-model'] });
  assert.deepEqual(add, { safe: true, reason: 'unchanged', changed: [], detail: null });
  const edit = davParseWasm.presetReload({ baseline: BASE, current: BASE.replace('8192', '4096'), loaded: ['loaded-model', 'other'] });
  assert.deepEqual(edit, { safe: false, reason: 'changed', changed: ['loaded-model'], detail: null });
  const glob = davParseWasm.presetReload({ baseline: BASE, current: BASE.replace('1024', '2048'), loaded: ['other'] });
  assert.deepEqual(glob.changed, ['other']);
  const dup = davParseWasm.presetReload({ baseline: BASE, current: BASE + '[other]\n', loaded: ['loaded-model'] });
  assert.deepEqual(dup, { safe: false, reason: 'ambiguous', changed: [], detail: 'duplicate_section' });
  assert.throws(() => davParseWasm.presetReload({ baseline: 1, current: '', loaded: [] }), { reason: 'input' });
  assert.throws(() => davParseWasm.presetReload({ baseline: 'x'.repeat(davParseWasm.MAX_RELOAD_BYTES), current: '', loaded: [] }), { reason: 'too_large' });
  // The guard wired to the real module.
  const g = createReloadGuard({ env: WASM });
  g.record(BASE, rows([]), BASE);
  assert.equal(g.verdict(BASE + '[new]\nmodel = /models/n.gguf\n', rows(['loaded-model']), ['loaded-model']).safe, true);
  assert.equal(g.verdict(BASE.replace('8192', '1'), rows(['loaded-model']), ['loaded-model']).safe, false);
});
