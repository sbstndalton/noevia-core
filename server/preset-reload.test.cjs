'use strict';
// #1012: a router preset reload may keep loaded models only with the maintenance gate, a recorded
// router view and Rust's safe check (always on since #1071; PRESET_RELOAD_IMPL is retired). Synthetic presets only.
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

// A stand-in for the Rust check in the unit tests: the loaded sections and [*] must be identical.
function sectionOf(text, name) { const m = new RegExp(`^\\[${name.replace(/[*.-]/g, '\\$&')}\\]\\n([^[]*)`, 'm').exec(text); return m ? m[1] : null; }
function fakeCheck({ baseline, current, loaded }) {
  const changed = loaded.filter((id) => sectionOf(baseline, '*') !== sectionOf(current, '*') || sectionOf(baseline, id) !== sectionOf(current, id));
  return { safe: !changed.length, reason: changed.length ? 'changed' : 'unchanged', changed, detail: null };
}

function tmp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preset-reload-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
const rows = (loaded, presets = {}, sleeping = []) => ['loaded-model', 'other'].map((id) => ({ id, status: { value: sleeping.includes(id) ? 'sleeping' : loaded.includes(id) ? 'loaded' : 'unloaded', preset: presets[id] ?? `[${id}]` } }));

test('#1012 guard: unknown without a baseline, and fails closed on a moved router or a failed check', (t) => {
  assert.equal(createReloadGuard({ check: fakeCheck }).mode, undefined, 'no off/on mode any more');
  assert.equal(require('./preset-reload.cjs').FLAG, undefined);

  const g = createReloadGuard({ check: fakeCheck });
  assert.equal(g.verdict(BASE, rows([]), ['loaded-model']).reason, 'unknown');
  g.record(BASE, rows([]), BASE);
  assert.equal(g.verdict(BASE + '[new]\nmodel = /models/n.gguf\n', rows(['loaded-model']), ['loaded-model']).safe, true, 'load state alone is not a router change');
  assert.equal(g.verdict(BASE, rows([], { other: '[other]\nctx-size = 1' }), ['loaded-model']).reason, 'engine_moved');
  assert.equal(g.verdict(null, rows([]), ['loaded-model']).reason, 'unreadable');
  assert.deepEqual(g.verdict(BASE.replace('8192', '4096'), rows([]), ['loaded-model']), { safe: false, reason: 'changed', changed: ['loaded-model'] });
  const throwing = createReloadGuard({ check: () => { throw new Error('trap'); } });
  throwing.record(BASE, rows([]), BASE);
  assert.equal(throwing.verdict(BASE, rows([]), ['loaded-model']).reason, 'check_failed');
  // A file that moved while the router reloaded leaves the baseline unknown.
  g.record(BASE, rows([]), BASE + '\n[x]\n');
  assert.equal(g.verdict(BASE, rows([]), ['loaded-model']).reason, 'unknown');
});

test('#1012 guard: the baseline survives a core restart and forget() removes it', (t) => {
  const stateFile = path.join(tmp(t), 'state.json');
  const a = createReloadGuard({ stateFile, check: fakeCheck });
  a.record(BASE, rows([]), BASE);
  assert.equal((fs.statSync(stateFile).mode & 0o777), 0o600);
  const b = createReloadGuard({ stateFile, check: fakeCheck });
  assert.equal(b.known(), true);
  assert.equal(b.verdict(BASE, rows([]), ['loaded-model']).safe, true);
  b.forget();
  assert.equal(fs.readFileSync(stateFile, 'utf8'), '{}', 'forget() leaves a tombstone, not a missing file');
  assert.equal(createReloadGuard({ stateFile, check: fakeCheck }).known(), false);
  fs.writeFileSync(stateFile, '{not json');
  assert.equal(createReloadGuard({ stateFile, check: fakeCheck }).known(), false);
});

test('#1037 a router row without a string status.preset leaves the baseline unknown', () => {
  const bare = rows([]).map((r, i) => (i === 1 ? { ...r, status: { value: 'unloaded' } } : r));
  assert.equal(engineView(bare), null);
  assert.equal(engineView({}), null);
  const g = createReloadGuard({ check: fakeCheck });
  g.record(BASE, bare, BASE);
  assert.equal(g.known(), false, 'no baseline from a partial view');
  g.record(BASE, rows([]), BASE);
  assert.deepEqual(g.verdict(BASE, bare, ['loaded-model']), { safe: false, reason: 'unknown' });
});

test('#1012 engineView is order-independent and sees preset changes and new or removed models', () => {
  const r = rows([]);
  assert.equal(engineView(r), engineView([...r].reverse()));
  assert.notEqual(engineView(r), engineView(rows([], { other: '[other]\nx = 1' })));
  assert.notEqual(engineView(r), engineView(r.slice(1)));
});

function managerFixture(t) {
  const dir = tmp(t);
  const file = path.join(dir, 'models.ini');
  fs.writeFileSync(file, BASE);
  const state = { loaded: [], sleeping: [], calls: [], presets: {}, onList: null, bare: false };
  const fetchJson = async (url, opts = {}) => {
    const u = new URL(url);
    state.calls.push(`${opts.method || 'GET'} ${u.pathname}${u.search}`);
    if (u.pathname === '/models' && !u.search && state.onList) state.onList(state.calls.filter((c) => c === 'GET /models').length);
    if (u.pathname === '/models/unload') { const id = JSON.parse(opts.body).model; state.loaded = state.loaded.filter((x) => x !== id); return { ok: true, status: 200, body: { success: true } }; }
    const data = rows(state.loaded, state.presets, state.sleeping);
    return { ok: true, status: 200, body: { data: state.bare ? data.map((r) => ({ ...r, status: { value: r.status.value } })) : data } };
  };
  const reloadGuard = createReloadGuard({ check: fakeCheck, stateFile: path.join(dir, 'reload.json') });
  const manager = createLlamaCppManager({ baseUrl: 'http://synthetic', presetPath: file, fetchJson, reloadGuard });
  return { file, state, manager, reloads: () => state.calls.filter((c) => c === 'GET /models?reload=1').length };
}

test('#1012 a new section is served without unloading the loaded model', async (t) => {
  const f = managerFixture(t);
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

test('#1012 an edit to the loaded model, an unknown baseline or a moved router still refuses', async (t) => {
  const f = managerFixture(t);
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
  const f = managerFixture(t);
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

test('#2276 writePresets: a 502 from the remote hold is not holdRefused and writes nothing', async (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'models.ini');
  fs.writeFileSync(file, BASE);
  const down = Object.assign(new Error('The local model engine is not answering.'), { status: 502, code: 'engine_unavailable', retryable: true });
  const gate = { holdMaintenance: async () => { throw down; }, hasAdmin: () => true, waiting: () => 0, adminHeaders: () => ({}) };
  const manager = createLlamaCppManager({ baseUrl: 'http://synthetic', presetPath: file, gate });
  let writes = 0;
  await assert.rejects(manager.writePresets(async () => { writes += 1; }), (e) => e.status === 502 && e.code === 'engine_unavailable' && e.holdRefused !== true);
  assert.equal(writes, 0);
});

test('#2219 writePresets: a held gate means no write; a write and its reload share one hold', async (t) => {
  const f = managerFixture(t);
  let writes = 0;
  const release = f.manager.holdMaintenance('synthetic tune');
  await assert.rejects(f.manager.writePresets(async () => { writes += 1; }), { status: 409, holdRefused: true });
  release();
  const leave = f.manager.enterInference();
  await assert.rejects(f.manager.writePresets(async () => { writes += 1; }), { holdRefused: true });
  leave();
  assert.equal(writes, 0);
  assert.equal(f.reloads(), 0);

  // A reload from anywhere cannot run between the write and its own reload.
  const text = fs.readFileSync(f.file, 'utf8');
  const { written, reload } = await f.manager.writePresets(async () => {
    fs.appendFileSync(f.file, '[gemma-synthetic]\nmodel = /models/g.gguf\n');
    await assert.rejects(f.manager.reloadPresets(), { status: 409 });
    return 'done';
  });
  assert.equal(written, 'done');
  assert.equal(reload.status, 200);
  assert.equal(f.reloads(), 1);
  assert.notEqual(fs.readFileSync(f.file, 'utf8'), text);
  // A write that changed nothing does not reload, and the hold ends either way.
  const none = await f.manager.writePresets(async () => 'same', () => false);
  assert.equal(none.reload, null);
  await assert.rejects(f.manager.writePresets(async () => { throw Error('write failed'); }), /write failed/);
  assert.equal((await f.manager.reloadPresets()).status, 200);
});

test('#1040 the file is re-read right before the reload and must be the text that was judged', async (t) => {
  const f = managerFixture(t);
  await f.manager.reloadPresets();
  f.state.loaded = ['loaded-model'];
  const lists = f.state.calls.filter((c) => c === 'GET /models').length;
  // The second listing (right before the call) is where a concurrent write lands.
  f.state.onList = (n) => { if (n === lists + 2) fs.writeFileSync(f.file, BASE.replace('ctx-size = 8192', 'ctx-size = 1')); };
  const r = await f.manager.reloadPresets();
  assert.equal(r.status, 409); assert.equal(r.body.reason, 'file_changed');
  assert.equal(f.reloads(), 1);
});

test('#1040 a model that starts loading between the check and the call refuses the reload', async (t) => {
  const f = managerFixture(t);
  await f.manager.reloadPresets();
  f.state.loaded = ['loaded-model'];
  const lists = f.state.calls.filter((c) => c === 'GET /models').length;
  f.state.onList = (n) => { if (n === lists + 2) f.state.loaded = ['loaded-model', 'other']; };
  const r = await f.manager.reloadPresets();
  assert.equal(r.status, 409); assert.equal(r.body.reason, 'loaded_changed'); assert.deepEqual(r.body.loaded, ['loaded-model', 'other']);
  assert.equal(f.reloads(), 1);
});

test('#1038 a sleeping model counts as loaded', async (t) => {
  const off = managerFixture(t);
  off.state.sleeping = ['loaded-model'];
  const r = await off.manager.reloadPresets();
  assert.equal(r.status, 409); assert.deepEqual(r.body.loaded, ['loaded-model']);
  const on = managerFixture(t);
  await on.manager.reloadPresets();
  on.state.sleeping = ['loaded-model'];
  fs.writeFileSync(on.file, BASE.replace('ctx-size = 8192', 'ctx-size = 2'));
  assert.equal((await on.manager.reloadPresets()).body.reason, 'changed');
  fs.writeFileSync(on.file, BASE + '[new]\nmodel = /models/n.gguf\n');
  assert.deepEqual((await on.manager.reloadPresets()).body.kept, ['loaded-model']);
});

test('#1037 a router listing without presets never yields a baseline, so loaded models refuse', async (t) => {
  const f = managerFixture(t);
  f.state.bare = true;
  await f.manager.reloadPresets();
  f.state.loaded = ['loaded-model'];
  assert.equal((await f.manager.reloadPresets()).body.reason, 'unknown');
});

test('#1012 a failed router reload forgets the baseline', async (t) => {
  const f = managerFixture(t);
  await f.manager.reloadPresets();
  const failing = createLlamaCppManager({ baseUrl: 'http://synthetic', presetPath: f.file, reloadGuard: createReloadGuard({ check: fakeCheck }),
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
  // #1039: llama.cpp's header/line grammar (common/preset.cpp 186-217 at eafe15a5e).
  for (const bad of ['[a]x\n', '[a]\u000b\n', '[a\u00a0]\n', '[ a]\n', '  [a]\n', '[a:Q4]\n', '[default]\n']) {
    assert.deepEqual(davParseWasm.presetReload({ baseline: BASE, current: BASE + bad, loaded: ['loaded-model'] }), { safe: false, reason: 'ambiguous', changed: [], detail: 'header' }, JSON.stringify(bad));
  }
  for (const bad of ['\ufeffversion = 1\n', '-ctx-size = 1\n', '= 1\n', '\u000bctx-size = 1\n']) {
    assert.deepEqual(davParseWasm.presetReload({ baseline: BASE, current: BASE + bad, loaded: ['loaded-model'] }), { safe: false, reason: 'ambiguous', changed: [], detail: 'line' }, JSON.stringify(bad));
  }
  assert.equal(davParseWasm.presetReload({ baseline: BASE, current: BASE + '[new]\t; note\nload-on-startup = true\n', loaded: ['loaded-model'] }).safe, true);
  assert.throws(() => davParseWasm.presetReload({ baseline: 1, current: '', loaded: [] }), { reason: 'input' });
  assert.throws(() => davParseWasm.presetReload({ baseline: 'x'.repeat(davParseWasm.MAX_RELOAD_BYTES), current: '', loaded: [] }), { reason: 'too_large' });
  // The guard wired to the real module.
  const g = createReloadGuard();
  g.record(BASE, rows([]), BASE);
  assert.equal(g.verdict(BASE + '[new]\nmodel = /models/n.gguf\n', rows(['loaded-model']), ['loaded-model']).safe, true);
  assert.equal(g.verdict(BASE.replace('8192', '1'), rows(['loaded-model']), ['loaded-model']).safe, false);
});

// noevia#1863: the text the router runs on is known only while its view matches the last reload.
test('#1863 routerText is the last reload text while the router has not re-read', () => {
  const g = createReloadGuard({ check: fakeCheck });
  assert.equal(g.routerText(rows([])), null, 'unknown before any reload');
  g.record('[*]\nsleep-idle-seconds = 1800\n', rows([]), '[*]\nsleep-idle-seconds = 1800\n');
  assert.equal(g.routerText(rows(['loaded-model'], {}, ['loaded-model'])), '[*]\nsleep-idle-seconds = 1800\n', 'loading or sleeping does not change the view');
  assert.equal(g.routerText(rows([], { other: '[other]\nctx-size = 1\n' })), null, 'a router that re-read on its own is unknown');
  assert.equal(g.routerText('not rows'), null);
  g.forget();
  assert.equal(g.routerText(rows([])), null);
});

// ── #2210: the Rust front is the other writer of the baseline file ─────────────────────────────────────────
const { LOCK_STALE_MS } = require('./preset-reload.cjs');
test('#2210 the baseline is read from the file on every use: what the other process records is seen, and forgotten', (t) => {
  const stateFile = path.join(tmp(t), 'state.json');
  const mine = createReloadGuard({ stateFile, check: fakeCheck }), theirs = createReloadGuard({ stateFile, check: fakeCheck });
  const router = rows(['loaded-model']);
  assert.equal(mine.known(), false);
  theirs.record(BASE, router, BASE);
  assert.equal(mine.known(), true, 'a baseline the front recorded is mine too');
  assert.equal(mine.verdict(BASE, router, ['loaded-model']).safe, true);
  assert.equal(mine.routerText(router), BASE);
  mine.forget();
  assert.equal(theirs.known(), false, 'and a baseline I forgot is forgotten for the front');
  assert.equal(theirs.verdict(BASE, router, ['loaded-model']).reason, 'unknown');
});

test('#2210 the file the front writes and the file Core writes are the same shape', (t) => {
  const stateFile = path.join(tmp(t), 'state.json');
  const router = rows(['loaded-model']);
  // The front writes {"text","view"} with serde_json's key order (alphabetical: text, view) and mode 0600.
  fs.writeFileSync(stateFile, JSON.stringify({ text: BASE, view: engineView(router) }), { mode: 0o600 });
  const guard = createReloadGuard({ stateFile, check: fakeCheck });
  assert.equal(guard.verdict(BASE, router, ['loaded-model']).safe, true);
  guard.record(BASE, router, BASE);
  assert.equal(fs.readFileSync(stateFile, 'utf8'), JSON.stringify({ text: BASE, view: engineView(router) }));
  assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(`${stateFile}.lock`), false, 'the lock is released');
  assert.deepEqual(fs.readdirSync(path.dirname(stateFile)).sort(), ['state.json']);
});

test('#2210 a write waits for the other writer\'s lock, takes over a dead one, and never half-writes', (t) => {
  const dir = tmp(t), stateFile = path.join(dir, 'state.json'), lock = `${stateFile}.lock`;
  const logs = [];
  const router = rows(['loaded-model']);
  // A live lock (the front is writing): the write gives up after its wait, logs it, and changes nothing.
  const first = createReloadGuard({ stateFile, check: fakeCheck, log: (m) => logs.push(m), lock: { waitMs: 150 } });
  first.record(BASE, router, BASE);
  const before = fs.readFileSync(stateFile, 'utf8');
  fs.writeFileSync(lock, '4242');
  first.forget();
  assert.equal(fs.readFileSync(stateFile, 'utf8'), before, 'the file the other writer is replacing is left alone');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /could not save the preset reload baseline/);
  assert.equal(fs.existsSync(lock), true, 'a lock that is not mine is not removed');
  // A lock older than the stale limit belongs to a writer that died: taken over.
  const old = new Date(Date.now() - LOCK_STALE_MS - 5000);
  fs.utimesSync(lock, old, old);
  first.forget();
  assert.equal(fs.readFileSync(stateFile, 'utf8'), '{}');
  assert.equal(fs.existsSync(lock), false);
  assert.equal(logs.length, 1);
});

test('#2210: a write that cannot take the lock is reported and the baseline is unknown until a write succeeds', (t) => {
  const stateFile = path.join(tmp(t), 'state.json');
  const logs = [];
  const guard = createReloadGuard({ stateFile, check: fakeCheck, log: (m) => logs.push(m), lock: { waitMs: 30 } });
  guard.record('text', rows([]), 'text');
  assert.equal(guard.known(), true);
  // Another writer holds the lock: this forget cannot write, so the old baseline is still on disk.
  fs.writeFileSync(`${stateFile}.lock`, 'other');
  guard.forget();
  assert.ok(JSON.parse(fs.readFileSync(stateFile, 'utf8')).text, 'the old baseline is still on disk');
  assert.equal(guard.known(), false, 'and is not trusted');
  assert.equal(guard.verdict('text', rows([]), []).safe, false);
  assert.match(logs.join('\n'), /could not save/);
  fs.rmSync(`${stateFile}.lock`);
  guard.record('text', rows([]), 'text');
  assert.equal(guard.known(), true, 'a later write that succeeds restores it');
});

test('#2210: a writer does not remove a lock another writer has taken over', (t) => {
  const stateFile = path.join(tmp(t), 'state.json');
  const lock = `${stateFile}.lock`;
  const realRename = fs.renameSync;
  // While this writer is inside its write, its lock goes stale and another writer takes it over.
  t.mock.method(fs, 'renameSync', (...args) => { fs.writeFileSync(lock, 'another-writer'); return realRename(...args); });
  createReloadGuard({ stateFile, check: fakeCheck }).forget();
  assert.equal(fs.readFileSync(lock, 'utf8'), 'another-writer');
});
