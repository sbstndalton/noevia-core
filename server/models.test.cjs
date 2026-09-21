'use strict';
// The model service over a fake adapter: the installed list and its loaded state, the first
// loaded model as the default, the role config and its warm-up, the manager call and the
// cached folder scan. The adapter itself is model-manager.test.cjs; the routes are
// routes/models.test.cjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createModelService } = require('./models.cjs');

function fixture({ enabled = true, routing = false, models = [], loaded = [], env = {}, fetchJson } = {}) {
  const calls = [];
  const workspace = { autoRoles: null, saves: 0, saveAutoRoles() { this.saves += 1; } };
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
  assert.deepEqual(installed[1], { name: 'chat-7b', sizeGB: 4.3, loaded: true, labels: [], mtp: installed[1].mtp, maxContext: 8192, suggested: true, status: 'loaded', failed: false, canDelete: false, source: null });
  assert.equal(installed[0].sizeGB, 0.6);
  assert.equal(installed[2].status, 'failed');
  assert.equal(installed[2].failed, true);
  assert.equal(f.service.lastLoadedModel(), 'chat-7b', 'an embedding model is never the default');
  assert.deepEqual(await f.service.servedCatalogue(), installed);
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

test('a checkpoint becomes a namespaced user model name', () => {
  const { service } = fixture();
  assert.equal(service.deriveUserModelName('org/Model-7B:Q4_K_M'), 'user.Model-7B-Q4_K_M');
  assert.equal(service.deriveUserModelName('org/Model 7B'), 'user.Model-7B');
  assert.equal(service.deriveUserModelName('bare'), 'user.bare');
});
