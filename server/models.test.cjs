'use strict';
// The model service over a fake adapter: the installed list and its loaded state, the first
// loaded model as the default, the role config and its warm-up, the manager call and the
// cached folder scan. The adapter itself is model-manager.test.cjs; the routes are
// routes/models.test.cjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createModelService } = require('./models.cjs');

function makeWorkspace(autoRoles = null) {
  return { autoRoles, saves: 0, saveAutoRoles() { this.saves += 1; } };
}

function fixture({ enabled = true, routing = false, models = [], loaded = [], env = {}, fetchJson, otherWorkspaces = [] } = {}) {
  const calls = [];
  const workspace = makeWorkspace();
  const modelManager = {
    enabled, capabilities: { routing },
    requireEnabled() { if (!enabled) throw new Error('model management is disabled'); },
    listModels: async () => ({ ok: true, status: 200, body: { data: models } }),
    health: async () => ({ ok: true, body: { all_models_loaded: loaded.map((model_name) => ({ model_name, loaded: true })) } }),
    load: async (name) => { calls.push(['load', name]); return { ok: name !== 'broken' }; },
  };
  const service = createModelService({
    fetchJson: fetchJson || (async (url, init) => { calls.push(['fetch', url, init]); return { ok: true, status: 200, body: { unregistered: ['x'] } }; }),
    env, modelManager, currentWorkspace: () => workspace,
    listWorkspaces: () => [workspace, ...otherWorkspaces],
  });
  return { service, workspace, calls, modelManager };
}

test('modelsInstalled hides hash duplicates, marks loaded models and remembers the first loaded one', async () => {
  const f = fixture({
    models: [{ id: 'embed-1', labels: ['embedding'], size: 0.55 }, { id: 'chat-7b', size: 4.26, max_context_window: 8192, suggested: true, can_remove: false }, { id: 'deadbeefdeadbeefdeadbeefdeadbeef12345678' }, { model_name: 'failed-x', status: { value: 'failed', failed: true } }],
    loaded: ['embed-1', 'chat-7b'],
  });
  assert.equal(f.service.lastLoadedModel(), null);
  const installed = await f.service.modelsInstalled();
  assert.deepEqual(installed.map((m) => m.name), ['embed-1', 'chat-7b', 'failed-x']);
  assert.deepEqual(installed[1], { name: 'chat-7b', sizeGB: 4.3, loaded: true, labels: [], mtp: installed[1].mtp, maxContext: 8192, suggested: true, status: 'loaded', failed: false, canDelete: false, sidecarProtected: false, missingFile: false, source: null });
  assert.equal(installed[0].sizeGB, 0.6);
  assert.equal(installed[2].status, 'failed');
  assert.equal(installed[2].failed, true);
  assert.equal(f.service.lastLoadedModel(), 'chat-7b', 'an embedding model is never the default');
  assert.deepEqual(await f.service.servedCatalogue(), installed);
});

test('#336: sidecarProtected is true for the configured embedding model, distinct from (and regardless of) canDelete', async () => {
  const f = fixture({
    env: { EMBEDDING_MODEL: 'nomic-embed-text-v1' },
    models: [
      // can_remove:true here on purpose: the manager itself sees nothing wrong with removing it,
      // but noevia's own embed sidecar still depends on the name — sidecarProtected catches that
      // even though canDelete (the manager's own signal) stays true.
      { id: 'nomic-embed-text-v1', labels: ['embedding'], size: 0.27, can_remove: true },
      { id: 'chat-7b', size: 4.26, can_remove: true },
      // The reverse also holds: can_remove:false alone (nothing to do with a sidecar) must not
      // set sidecarProtected — that used to collapse the two and hid a delete path that still
      // works through the client's canDelete:false fallback (regression fixed after #350 review).
      { id: 'unrelated-locked', size: 1.1, can_remove: false },
    ],
  });
  const installed = await f.service.modelsInstalled();
  const embed = installed.find((m) => m.name === 'nomic-embed-text-v1');
  assert.equal(embed.sidecarProtected, true);
  assert.equal(embed.canDelete, true, 'canDelete keeps its own (manager-reported) meaning');
  const chat = installed.find((m) => m.name === 'chat-7b');
  assert.equal(chat.sidecarProtected, false);
  assert.equal(chat.canDelete, true);
  const locked = installed.find((m) => m.name === 'unrelated-locked');
  assert.equal(locked.canDelete, false, 'can_remove:false still reaches canDelete, unchanged');
  assert.equal(locked.sidecarProtected, false, 'but it is not a sidecar model, so sidecarProtected stays false');
});

test('#580: the embedding sidecar model reads as loaded from the backend probe, not the router status', async () => {
  const backends = [
    { name: 'cowork-llama-1', status: 'running', loaded_model: 'chat-7b', probe_error: null },
    { name: 'cowork-embed-1', status: 'running', loaded_model: 'nomic-embed-text-v1', probe_error: null },
  ];
  const urls = [];
  const fetchJson = async (url) => { urls.push(url); return url.endsWith('/api/v1/backends') ? { ok: true, status: 200, body: { backends } } : { ok: true, status: 200, body: {} }; };
  const f = fixture({
    env: { EMBEDDING_MODEL: 'nomic-embed-text-v1', MODEL_LOADER_URL: 'http://loader:8000/' }, fetchJson,
    models: [{ id: 'nomic-embed-text-v1', labels: ['embedding'], status: { value: 'unloaded' } }, { id: 'chat-7b', status: { value: 'unloaded' } }],
  });
  const by = Object.fromEntries((await f.service.modelsInstalled()).map((m) => [m.name, m]));
  assert.equal(by['nomic-embed-text-v1'].loaded, true);
  assert.equal(by['nomic-embed-text-v1'].status, 'loaded');
  assert.equal(by['nomic-embed-text-v1'].failed, false);
  assert.equal(by['chat-7b'].loaded, false, 'a non-sidecar model still follows the router');
  assert.equal(by['chat-7b'].status, 'unloaded');
  assert.ok(urls.includes('http://loader:8000/api/v1/backends'));
});

test('#580: an unreachable, stopped or empty backend leaves the sidecar model on the router state', async () => {
  const models = [{ id: 'nomic-embed-text-v1', labels: ['embedding'], status: { value: 'unloaded' } }];
  const env = { EMBEDDING_MODEL: 'nomic-embed-text-v1', MODEL_LOADER_URL: 'http://loader:8000' };
  for (const fetchJson of [
    async () => { throw new Error('down'); },
    async () => ({ ok: false, status: 502, body: {} }),
    async () => ({ ok: true, status: 200, body: { backends: [{ name: 'cowork-embed-1', status: 'exited', loaded_model: 'nomic-embed-text-v1' }] } }),
    async () => ({ ok: true, status: 200, body: { backends: [{ name: 'cowork-embed-1', status: 'running', loaded_model: null }] } }),
  ]) {
    const [m] = await fixture({ env, models, fetchJson }).service.modelsInstalled();
    assert.equal(m.loaded, false);
    assert.equal(m.status, 'unloaded');
  }
});

test('#580: no backend lookup when no sidecar model is installed', async () => {
  const urls = [];
  const f = fixture({ env: { MODEL_LOADER_URL: 'http://loader:8000' }, models: [{ id: 'chat-7b' }], fetchJson: async (u) => { urls.push(u); return { ok: true, body: {} }; } });
  await f.service.modelsInstalled();
  assert.ok(!urls.some((u) => u.includes('/backends')));
});

test('a disabled or unreachable manager reads as null from servedCatalogue and throws from modelsInstalled', async () => {
  const off = fixture({ enabled: false });
  assert.equal(await off.service.servedCatalogue(), null);
  await assert.rejects(off.service.modelsInstalled(), /model management is disabled/);
  const down = fixture();
  down.modelManager.listModels = async () => ({ ok: false, status: 503 });
  await assert.rejects(down.service.modelsInstalled(), /model list failed: 503/);
  assert.equal(await down.service.servedCatalogue(), null);
});

test('roles are saved with vision and code optional, and the warm-up loads only what is not loaded', async () => {
  const f = fixture({ models: [{ id: 'fast' }, { id: 'smart' }, { id: 'broken' }], loaded: ['fast'] });
  assert.equal(f.service.autoRoles(), null);
  f.service.setAutoRoles({ fast: 'fast', smart: 'smart', vision: '', code: 'broken' });
  assert.deepEqual(f.service.autoRoles(), { fast: 'fast', smart: 'smart', code: 'broken' });
  assert.equal(f.workspace.saves, 1);
  const warned = [];
  const original = console.warn; console.warn = (...args) => warned.push(args.join(' '));
  try {
    f.service.ensureRolesLoaded();
    await new Promise((r) => setTimeout(r, 20));
  } finally { console.warn = original; }
  assert.deepEqual(f.calls.filter((c) => c[0] === 'load'), [['load', 'smart'], ['load', 'broken']], 'fast is already loaded');
  assert.equal(warned.length, 1);
  assert.match(warned[0], /could not load code model \(broken\)/);
  await assert.rejects(f.service.ensureModelLoaded('ghost'), /model not installed: ghost/);
});

test('with native routing the warm-up is a no-op', async () => {
  const f = fixture({ routing: true, models: [{ id: 'smart' }] });
  f.service.setAutoRoles({ fast: 'smart', smart: 'smart' });
  f.service.ensureRolesLoaded();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(f.calls.filter((c) => c[0] === 'load'), []);
});

test('the manager call carries the token and the folder scan is cached once', async () => {
  const f = fixture({ env: { MODEL_LOADER_URL: 'http://loader:9000/', MODEL_LOADER_TOKEN: 't0k' } });
  const r = await f.service.managerFetch('models');
  assert.deepEqual(r.body, { unregistered: ['x'] });
  assert.equal(f.calls[0][1], 'http://loader:9000/api/v1/models');
  assert.equal(f.calls[0][2].headers['X-Model-Loader-Token'], 't0k');
  await f.service.managerFetch('sections/a/safe-defaults', 'POST');
  assert.equal(f.calls[1][2].body, '{}');
  f.service.refreshModelScan();
  f.service.refreshModelScan();
  await new Promise((r) => setImmediate(r));
  assert.equal(f.calls.filter((c) => c[0] === 'fetch').length, 3, 'a scan already in flight is not repeated');
  assert.deepEqual(f.service.modelScanCache.get('models').body, { unregistered: ['x'] });
  const unset = fixture({ env: {} });
  unset.service.refreshModelScan();
  assert.equal(unset.calls.length, 0, 'no service URL: nothing to scan');
});

test('clearRoleReferences drops the optional roles and falls the required ones back to each other', () => {
  const f = fixture();
  assert.deepEqual(f.service.clearRoleReferences('m'), [], 'no roles configured yet: nothing to clear');

  f.service.setAutoRoles({ fast: 'm', smart: 'keep', vision: 'm', code: 'keep-code' });
  assert.deepEqual(f.service.clearRoleReferences('m'), ['fast', 'vision']);
  assert.deepEqual(f.service.autoRoles(), { fast: 'keep', smart: 'keep', code: 'keep-code' });

  assert.deepEqual(f.service.clearRoleReferences('nope'), [], 'a model no role points at clears nothing and does not resave');
});

test('when both required roles would end up empty, the whole config is unset rather than saved as fast:\'\' smart:\'\'', () => {
  const f = fixture();
  f.service.setAutoRoles({ fast: 'm', smart: 'm' });
  const savesBefore = f.workspace.saves;
  assert.deepEqual(f.service.clearRoleReferences('m'), ['fast', 'smart'], 'both required roles pointed at the deleted model, with no candidate left');
  assert.equal(f.service.autoRoles(), null, 'unset (null), not { fast: "", smart: "" } — chat.cjs reads this as "not configured yet"');
  assert.equal(f.workspace.saves, savesBefore + 1);
});

test('clearRoleReferences fixes every workspace it can see, not just the current one, and reports only the current workspace\'s cleared roles', () => {
  const other1 = makeWorkspace({ fast: 'm', smart: 'other-smart' });
  const other2 = makeWorkspace({ fast: 'untouched', smart: 'also-untouched', vision: 'm' });
  const f = fixture({ otherWorkspaces: [other1, other2] });
  f.service.setAutoRoles({ fast: 'keep-fast', smart: 'm' });

  const cleared = f.service.clearRoleReferences('m');

  assert.deepEqual(cleared, ['smart'], 'the return value only describes the current (requesting) workspace');
  assert.deepEqual(f.service.autoRoles(), { fast: 'keep-fast', smart: 'keep-fast' }, 'current workspace: smart falls back to fast');
  assert.deepEqual(other1.autoRoles, { fast: 'other-smart', smart: 'other-smart' }, 'other workspace 1 is fixed silently: fast falls back to smart');
  assert.equal(other1.saves, 1);
  assert.deepEqual(other2.autoRoles, { fast: 'untouched', smart: 'also-untouched' }, 'other workspace 2: the optional vision role referencing it is dropped');
  assert.equal(other2.saves, 1);
});

test('clearLastLoadedModel only clears when the name still matches (a load in between is left alone)', async () => {
  const f = fixture({ models: [{ id: 'm' }], loaded: ['m'] });
  await f.service.modelsInstalled();
  assert.equal(f.service.lastLoadedModel(), 'm');
  f.service.clearLastLoadedModel('other');
  assert.equal(f.service.lastLoadedModel(), 'm', 'clearing a different name is a no-op');
  f.service.clearLastLoadedModel('m');
  assert.equal(f.service.lastLoadedModel(), null);
});

test('a checkpoint becomes a namespaced user model name', () => {
  const { service } = fixture();
  assert.equal(service.deriveUserModelName('org/Model-7B:Q4_K_M'), 'user.Model-7B-Q4_K_M');
  assert.equal(service.deriveUserModelName('org/Model 7B'), 'user.Model-7B');
  assert.equal(service.deriveUserModelName('bare'), 'user.bare');
});

test('#545: a models.ini preset whose file is not in the folder scan reads as missing and failed; cache-sourced models and other presets are untouched', async () => {
  const f = fixture({
    env: { MODEL_LOADER_URL: 'http://loader' },
    models: [
      { id: 'laya_multilingual_f16', source: 'preset', size: 0 },
      { id: 'present-7b', source: 'preset', size: 4 },
      { id: 'renamed-section', source: 'preset', size: 2 },
      { id: 'from-cache', source: 'cache', size: 1 },
    ],
    fetchJson: async () => ({ ok: true, status: 200, body: { models: [
      { key: 'a.gguf', modelId: 'present-7b', sections: ['present-7b'] },
      { key: 'b.gguf', modelId: 'b', sections: ['renamed-section'] },
    ] } }),
  });
  const installed = await f.service.modelsInstalled();
  const by = Object.fromEntries(installed.map((m) => [m.name, m]));
  assert.equal(by.laya_multilingual_f16.missingFile, true);
  assert.equal(by.laya_multilingual_f16.failed, true);
  assert.equal(by.laya_multilingual_f16.status, 'missing');
  assert.equal(by['present-7b'].missingFile, false);
  assert.equal(by['renamed-section'].missingFile, false, 'a section renamed to a short id still owns its file');
  assert.equal(by['from-cache'].missingFile, false, 'download-cache models have no folder file by design');
  await assert.rejects(f.service.ensureModelLoaded('laya_multilingual_f16'), /file missing/);
});

test('#545: an unreadable or empty folder scan never marks presets missing', async () => {
  const models = [{ id: 'x', source: 'preset' }];
  for (const fetchJson of [async () => ({ ok: false, status: 502 }), async () => { throw new Error('down'); }, async () => ({ ok: true, status: 200, body: { models: [] } })]) {
    const f = fixture({ env: { MODEL_LOADER_URL: 'http://loader' }, models, fetchJson });
    const [row] = await f.service.modelsInstalled();
    assert.equal(row.missingFile, false);
    assert.equal(row.failed, false);
  }
  const noLoader = fixture({ models });
  assert.equal((await noLoader.service.modelsInstalled())[0].missingFile, false);
});
