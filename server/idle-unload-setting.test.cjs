'use strict';
// noevia#1863: the chat-model idle unload time as an admin setting. A fake model manager that
// keeps the same contract as noevia-rs GET/PUT /api/v1/idle-unload; no engine, no model.
const test = require('node:test'), assert = require('node:assert/strict');
const { createIdleUnloadSetting, validSeconds, globalIdleSeconds, DEFAULT_SECONDS } = require('./idle-unload-setting.cjs');

const ENV = { MODEL_LOADER_URL: 'http://loader:8090/', MODEL_LOADER_TOKEN: 'synthetic-token' };

/** The model manager: env seed (null = blank), stored choice, and the preset's [*] key. */
function fakeLoader({ envSeconds = null, missing = false, down = false } = {}) {
  const state = { stored: undefined, ini: null, calls: [] };
  const fallback = () => (envSeconds === null ? { s: 1800, src: 'default' } : { s: envSeconds, src: 'env' });
  const view = () => {
    const f = fallback();
    const on = state.stored !== undefined;
    return { seconds: on ? state.stored : f.s, source: on ? 'setting' : f.src, fallbackSeconds: f.s, fallbackSource: f.src, defaultSeconds: 1800, minSeconds: 300, maxSeconds: 86400 };
  };
  state.ini = view().seconds;
  const fetchJson = async (url, init) => {
    state.calls.push({ url, init });
    if (down) throw Error('ECONNREFUSED');
    if (missing) return { ok: false, status: 404, body: { detail: 'Not Found' } };
    assert.equal(url, 'http://loader:8090/api/v1/idle-unload');
    assert.equal(init.headers['X-Model-Loader-Token'], 'synthetic-token');
    if (init.method === 'GET') return { ok: true, status: 200, body: view() };
    const { seconds } = JSON.parse(init.body);
    if (seconds === null) state.stored = undefined; else state.stored = seconds;
    const before = state.ini; state.ini = view().seconds;
    return { ok: true, status: 200, body: { ...view(), preset: before === state.ini ? 'unchanged' : 'written' } };
  };
  return { state, fetchJson };
}

const ini = (seconds) => (seconds ? `[*]\nsleep-idle-seconds = ${seconds}\n\n[chat]\nmodel = c.gguf\n` : '[*]\n\n[chat]\nmodel = c.gguf\n');

/** The router: the text it last read (null: unknowable), refusing a plain reload while `loaded` runs. */
function setup({ loader = fakeLoader(), loaded = [] } = {}) {
  const audit = [], reloads = [];
  const router = { text: ini(loader.state.ini), loaded: [...loaded] };
  const reloadPresets = async (o) => {
    reloads.push(o);
    if (router.loaded.length && !o.unload) return { ok: false, status: 409, body: { error: 'A model is loaded.', loaded: [...router.loaded] } };
    router.loaded = []; router.text = ini(loader.state.ini);
    return { ok: true, status: 200, body: { reloaded: true } };
  };
  const setting = createIdleUnloadSetting({ env: ENV, fetchJson: loader.fetchJson, reloadPresets, presetsInRouter: async () => router.text, audit: (...a) => audit.push(a) });
  return { setting, loader, audit, reloads, router, reloadPresets };
}

test('the default is 30 minutes', async () => {
  assert.equal(DEFAULT_SECONDS, 1800);
  const { setting } = setup();
  assert.deepEqual(await setting.get(), { seconds: 1800, source: 'default', fallbackSeconds: 1800, fallbackSource: 'default', defaultSeconds: 1800, minSeconds: 300, maxSeconds: 86400, applied: true });
});

test('the deployment env seeds the value and clearing the setting falls back to it', async () => {
  const { setting, loader } = setup({ loader: fakeLoader({ envSeconds: 900 }) });
  assert.equal((await setting.get()).source, 'env');
  assert.equal((await setting.save({ seconds: 7200 }, 'admin-1')).seconds, 7200);
  const cleared = await setting.save({ seconds: null }, 'admin-1');
  assert.equal(cleared.seconds, 900);
  assert.equal(cleared.source, 'env');
  assert.equal(loader.state.ini, 900);
});

test('a saved value persists, is audited, and takes effect without a restart', async () => {
  const { setting, loader, audit, reloads } = setup();
  const out = await setting.save({ seconds: 3600 }, 'admin-1');
  assert.deepEqual(out.apply, { state: 'applied' });
  assert.equal(out.seconds, 3600);
  assert.equal(out.source, 'setting');
  // The model manager now holds it (a fresh read sees it) and wrote the preset key.
  assert.equal((await setting.get()).seconds, 3600);
  assert.equal(loader.state.ini, 3600);
  // The router was asked to re-read its presets, never to unload a running model.
  assert.deepEqual(reloads, [{ unload: false }]);
  assert.deepEqual(audit, [['models.idle_unload', 'admin-1', { seconds: 3600, source: 'setting', previous: 1800 }]]);
  // Never.
  assert.equal((await setting.save({ seconds: 0 }, 'admin-1')).seconds, 0);
  assert.equal(loader.state.ini, 0);
});

test('with a model running the new time waits for it instead of unloading it', async () => {
  const { setting, reloads } = setup({ loaded: ['chat-synthetic'] });
  const out = await setting.save({ seconds: 600 }, 'admin-1');
  assert.deepEqual(out.apply, { state: 'pending', loaded: ['chat-synthetic'] });
  assert.equal(out.seconds, 600);
  assert.equal(out.applied, false);
  assert.deepEqual(reloads, [{ unload: false }]);
});

// Review of web#87: a model asleep after its idle time still blocks the reload, so the saved
// value is usually not live. Every GET says so (it survives a page reload) until a reload lands.
test('a GET reports whether the router runs on the saved value, across reloads of the page', async () => {
  const s = setup({ loaded: ['chat-asleep'] });
  assert.equal((await s.setting.get()).applied, true, 'the router read 1800 at its last reload');
  await s.setting.save({ seconds: 600 }, 'admin-1');
  for (let i = 0; i < 2; i++) assert.equal((await s.setting.get()).applied, false, 'still not live on a fresh GET');
  await s.reloadPresets({ unload: true });
  assert.equal((await s.setting.get()).applied, true);
  // Saving the value the router already runs on is applied at once.
  const again = await s.setting.save({ seconds: 600 }, 'admin-1');
  assert.equal(again.applied, true);
  // Unknowable (the router re-read on its own since noevia's last reload): not claimed as applied.
  s.router.text = null;
  assert.equal((await s.setting.get()).applied, false);
  // Never: no key in [*].
  s.router.text = ini(0); s.loader.state.stored = 0;
  assert.equal((await s.setting.get()).applied, true);
});

test('the [*] key is read the way the model manager writes it', () => {
  assert.equal(globalIdleSeconds(ini(1800)), 1800);
  assert.equal(globalIdleSeconds(ini(0)), 0);
  assert.equal(globalIdleSeconds('[chat]\nsleep-idle-seconds = 5\n'), 0, 'a model section is not the global one');
  assert.equal(globalIdleSeconds('[*]\r\n--sleep-idle-seconds=60\r\n'), 60);
  assert.equal(globalIdleSeconds('[*]\nsleep-idle-seconds = soon\n'), null);
  assert.equal(globalIdleSeconds('[*]\n; sleep-idle-seconds = 5\n'), 0);
});

test('values outside Never or 5 min to 24 h are refused before the model manager is asked', async () => {
  for (const ok of [0, 300, 1800, 86400, null]) assert.equal(validSeconds(ok), true, String(ok));
  for (const bad of [1, 60, 299, 86401, 604800, -1, 1800.5, '1800', true, undefined, {}, NaN]) assert.equal(validSeconds(bad), false, String(bad));
  const { setting, loader, audit, reloads } = setup();
  for (const body of [{ seconds: 60 }, { seconds: '1800' }, {}, null, [1800]]) {
    await assert.rejects(setting.save(body, 'admin-1'), (e) => e.status === 400 && e.errorId === 'idleUnloadInvalid' && e.minSeconds === 300);
  }
  assert.equal(loader.state.calls.length, 0);
  assert.deepEqual(audit, []);
  assert.deepEqual(reloads, []);
});

test('an older or unreachable model manager is reported, nothing is audited', async () => {
  const old = setup({ loader: fakeLoader({ missing: true }) });
  await assert.rejects(old.setting.get(), (e) => e.status === 404 && e.errorId === 'idleUnloadUnavailable');
  await assert.rejects(old.setting.save({ seconds: 600 }, 'a'), (e) => e.status === 404);
  const down = setup({ loader: fakeLoader({ down: true }) });
  await assert.rejects(down.setting.save({ seconds: 600 }, 'a'), (e) => e.status === 502 && e.errorId === 'idleUnloadEngine');
  assert.deepEqual([...old.audit, ...down.audit], []);
  assert.deepEqual([...old.reloads, ...down.reloads], []);
  const noLoader = createIdleUnloadSetting({ env: {}, fetchJson: async () => { throw Error('not called'); } });
  await assert.rejects(noLoader.get(), (e) => e.status === 404);
});

test('a preset the model manager could not rewrite is reported, and no reload is attempted', async () => {
  const fetchJson = async (_u, init) => ({ ok: true, status: 200, body: { seconds: init.method === 'PUT' ? 600 : 1800, source: init.method === 'PUT' ? 'setting' : 'default', preset: 'failed' } });
  const reloads = [];
  const setting = createIdleUnloadSetting({ env: ENV, fetchJson, reloadPresets: async (o) => { reloads.push(o); return { ok: true }; } });
  assert.deepEqual((await setting.save({ seconds: 600 }, 'a')).apply, { state: 'failed' });
  assert.deepEqual(reloads, []);
});
