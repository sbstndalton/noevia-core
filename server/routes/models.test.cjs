'use strict';
// The model routes over a fake adapter and service: the administrator gate on every write,
// the proxy with its cached folder scan, and the words each refusal keeps. The numbers and
// the role config are models.test.cjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createModelRoutes } = require('./models.cjs');
const { createModelService } = require('../models.cjs');

// A workspace-shaped test double (autoRoles + saveAutoRoles), for tests that pass
// `otherWorkspaces` to check clearRoleReferences fixes every workspace it can see.
function makeWorkspace(autoRoles = null) {
  return { autoRoles, saves: 0, saveAutoRoles() { this.saves += 1; } };
}

function fixture({ env = {}, enabled = true, kind = 'llamacpp', manager = {}, workspace = { userId: 'u1' }, catalogue = [{ name: 'm' }], servedCatalogue = async () => catalogue, modelsInstalled = async () => [{ name: 'm', loaded: true }], initialRoles = null, initialLastLoaded = null, otherWorkspaces = [] } = {}) {
  const sent = [], headers = [], fetched = [];
  const scan = new Map();
  let refreshes = 0;
  const roles = { current: initialRoles, warmed: undefined };
  const lastLoaded = { current: initialLastLoaded };
  // clearRoleReferences below delegates to the REAL createModelService implementation (fallback,
  // unset-when-both-required-empty, every workspace) instead of a hand test-double reimplementing
  // that logic — a drift between the two previously would never have shown up here. `roles.current`
  // stays the bridge the rest of this fixture (autoRoles/setAutoRoles, and every existing test's
  // assertions on `f.roles.current`) already reads and writes.
  const roleWorkspace = { get autoRoles() { return roles.current; }, set autoRoles(v) { roles.current = v; }, saveAutoRoles() {} };
  const roleService = createModelService({
    fetchJson: async () => ({ ok: false }), env: {}, modelManager: { enabled: false, requireEnabled() { throw new Error('model management is disabled'); } },
    currentWorkspace: () => roleWorkspace, listWorkspaces: () => [roleWorkspace, ...otherWorkspaces],
  });
  const modelManager = {
    enabled, kind, capabilities: { routing: true },
    stats: async () => ({ ok: true, body: { scope: 'engine', tokens_per_second: 41.5, mtp: [] } }),
    systemStats: async () => ({ ok: true, body: { cpu_percent: 12, vram_gb: 7.5 } }),
    health: async () => ({ ok: true, body: { all_models_loaded: [] } }),
    metrics: async () => ({ ok: false }),
    listModels: async () => ({ ok: true, body: { data: [] } }),
    downloads: async () => ({ ok: true, body: { jobs: [{ id: 'j1', model_name: 'm', percent: 40, status: 'running' }] } }),
    pull: async ({ modelName }) => ({ ok: true, body: { id: 'pull-1', modelName } }),
    deleteModel: async () => ({ ok: false, status: 500 }),
    load: async () => ({ ok: true }), unload: async () => ({ ok: true }),
    ...manager,
  };
  const routes = createModelRoutes({
    json: (res, status, body) => { sent.push({ status, body }); },
    readBody: async (req) => { let s = ''; for await (const c of req) s += c; return s; },
    readJson: async (req) => { let s = ''; for await (const c of req) s += c; return s ? JSON.parse(s) : {}; },
    fetchJson: async (url, init) => { fetched.push({ url, init }); return { ok: true, status: 200, body: { models: ['a'] } }; },
    env, modelManager,
    getProvider: () => ({ baseUrl: 'http://engine', apiKey: 'local' }), providerHeaders: () => ({}), DEFAULT_PROVIDER_ID: 'default',
    createVisionProbe: () => async () => ({ supported: true }),
    reportedTokenRate: (g) => g.tokens_per_second ?? null,
    missingRoles: (r, catalogue) => ({ roles: r, catalogue }),
    currentWorkspace: () => workspace,
    service: {
      modelScanCache: scan, refreshModelScan: () => { refreshes += 1; },
      autoRoles: () => roles.current, setAutoRoles: (next) => { roles.current = next; }, ensureRolesLoaded: () => { roles.warmed = true; },
      servedCatalogue, modelsInstalled,
      deriveUserModelName: (c) => `user.${c}`,
      lastLoadedModel: () => lastLoaded.current,
      clearLastLoadedModel: (name) => { if (lastLoaded.current === name) lastLoaded.current = null; },
      clearRoleReferences: (name) => roleService.clearRoleReferences(name),
    },
  });
  const call = (method, path, body, role = 'member', search = '') => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
    req.method = method;
    const res = { setHeader: (k, v) => headers.push([k, v]) };
    return routes(req, res, { path, authn: { user: { id: 'u1', role } }, url: new URL(`http://localhost${path}${search}`) });
  };
  return { call, sent, headers, fetched, scan, refreshes: () => refreshes, roles, lastLoaded };
}

test('every write under /api/models/ is refused for members before anything else is looked at', async () => {
  const f = fixture();
  assert.equal(await f.call('POST', '/api/models/anything-at-all'), true);
  assert.deepEqual(f.sent.pop(), { status: 403, body: { error: 'administrator required' } });
  assert.equal(await f.call('GET', '/api/models/downloads'), true, 'reads stay open to members');
  assert.deepEqual(f.sent.pop(), { status: 200, body: [{ id: 'j1', model: 'm', progress: 0.4, status: 'running' }] });
  assert.equal(await f.call('GET', '/api/model'), false);
  assert.equal(await f.call('DELETE', '/api/auto-roles'), false, 'an unhandled method keeps falling through');
});

test('stats and capabilities read the adapter; the roles round-trip and warm up', async () => {
  const f = fixture({ env: { MODEL_LOADER_URL: 'http://loader' } });
  await f.call('GET', '/api/stats');
  const stats = f.sent.pop();
  assert.equal(stats.status, 200);
  assert.equal(stats.body.up, true);
  assert.equal(stats.body.tokensPerSecond, 41.5);
  assert.equal(stats.body.cpuPercent, 12);
  assert.equal(stats.body.gpuPercent, null);
  await f.call('GET', '/api/models/capabilities', undefined, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { kind: 'llamacpp', enabled: true, admin: true, routing: true, modelManagement: true } });
  await f.call('GET', '/api/models/capabilities');
  assert.equal(f.sent.pop().body.modelManagement, false, 'members do not see model management');
  await f.call('GET', '/api/auto-roles');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { configured: false, roles: null, missing: { roles: null, catalogue: [{ name: 'm' }] } } });
  await f.call('PUT', '/api/auto-roles', { fast: ' m ', smart: 'm' }, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { configured: true, roles: { fast: 'm', smart: 'm', vision: '', code: '' } } });
  assert.equal(f.roles.warmed, true, 'an admin save warms the roles up');
  await f.call('PUT', '/api/auto-roles', { fast: 'f' });
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'both fast and smart model names are required' } });
  await f.call('PUT', '/api/auto-roles', '{');
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'invalid JSON' } });
});

test('a member may save their own auto-roles but never warms the shared engine, and unknown names 400', async () => {
  const f = fixture({ env: { MODEL_LOADER_URL: 'http://loader' } });
  await f.call('PUT', '/api/auto-roles', { fast: 'm', smart: 'm' }, 'member');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { configured: true, roles: { fast: 'm', smart: 'm', vision: '', code: '' } } });
  assert.equal(f.roles.warmed, undefined, 'a member save never calls ensureRolesLoaded / modelManager.load');

  const bad = fixture({ env: { MODEL_LOADER_URL: 'http://loader' } });
  await bad.call('PUT', '/api/auto-roles', { fast: 'nope', smart: 'm' }, 'admin');
  assert.deepEqual(bad.sent.pop(), { status: 400, body: { error: 'unknown model(s): nope' } });
  assert.equal(bad.roles.current, null, 'a bad name is never saved either');
  assert.equal(bad.roles.warmed, undefined);

  // When the catalogue cannot be read (engine unreachable), saving is still allowed.
  const unreachable = fixture({ env: { MODEL_LOADER_URL: 'http://loader' }, servedCatalogue: async () => null });
  await unreachable.call('PUT', '/api/auto-roles', { fast: 'anything', smart: 'goes' }, 'admin');
  assert.deepEqual(unreachable.sent.pop(), { status: 200, body: { configured: true, roles: { fast: 'anything', smart: 'goes', vision: '', code: '' } } });
});

test('#343/#442: PUT /api/auto-roles rejects a non-chat model for fast/smart/vision/code alike', async () => {
  const catalogue = [
    { name: 'chat-syn', labels: [] },
    { name: 'vec-syn', labels: ['embeddings'] },
    { name: 'laya_multilingual_f16', labels: [] },
  ];
  for (const role of ['fast', 'smart', 'vision', 'code']) {
    for (const actor of ['member', 'admin']) {
      const f = fixture({ env: { MODEL_LOADER_URL: 'http://loader' }, catalogue });
      const body = { fast: 'chat-syn', smart: 'chat-syn', [role]: 'vec-syn' };
      await f.call('PUT', '/api/auto-roles', body, actor);
      assert.deepEqual(f.sent.pop(), { status: 400, body: { error: `The ${role} role needs a chat model; vec-syn is an embedding, reranking or routing model.` } }, `${role}/${actor}`);
      assert.equal(f.roles.current, null, `${role}/${actor}: a rejected role is never saved`);
      assert.equal(f.roles.warmed, undefined, `${role}/${actor}: nothing is warmed up either`);
    }
  }
  // #442: Laya (the internal routing model — labels [], flagged by name via isSystemModel) is
  // rejected for vision the same way it already was for fast/smart/code.
  const laya = fixture({ env: { MODEL_LOADER_URL: 'http://loader' }, catalogue });
  await laya.call('PUT', '/api/auto-roles', { fast: 'chat-syn', smart: 'chat-syn', vision: 'laya_multilingual_f16' }, 'admin');
  assert.deepEqual(laya.sent.pop(), { status: 400, body: { error: 'The vision role needs a chat model; laya_multilingual_f16 is an embedding, reranking or routing model.' } });
  assert.equal(laya.roles.current, null, 'a rejected vision role is never saved');

  // A chat model in every text role still saves and (for an admin) still warms up.
  const good = fixture({ env: { MODEL_LOADER_URL: 'http://loader' }, catalogue });
  await good.call('PUT', '/api/auto-roles', { fast: 'chat-syn', smart: 'chat-syn', code: 'chat-syn' }, 'admin');
  assert.deepEqual(good.sent.pop(), { status: 200, body: { configured: true, roles: { fast: 'chat-syn', smart: 'chat-syn', vision: '', code: 'chat-syn' } } });
  assert.equal(good.roles.warmed, true);

  // #442: a vision-capable chat model (labels: ['vision']) is accepted for the vision role.
  const visionCatalogue = [...catalogue, { name: 'vision-syn', labels: ['vision'] }];
  const vision = fixture({ env: { MODEL_LOADER_URL: 'http://loader' }, catalogue: visionCatalogue });
  await vision.call('PUT', '/api/auto-roles', { fast: 'chat-syn', smart: 'chat-syn', vision: 'vision-syn' }, 'admin');
  assert.deepEqual(vision.sent.pop(), { status: 200, body: { configured: true, roles: { fast: 'chat-syn', smart: 'chat-syn', vision: 'vision-syn', code: '' } } });

  // #442: an empty/absent vision role stays valid (vision remains optional).
  const empty = fixture({ env: { MODEL_LOADER_URL: 'http://loader' }, catalogue });
  await empty.call('PUT', '/api/auto-roles', { fast: 'chat-syn', smart: 'chat-syn', vision: '' }, 'admin');
  assert.deepEqual(empty.sent.pop(), { status: 200, body: { configured: true, roles: { fast: 'chat-syn', smart: 'chat-syn', vision: '', code: '' } } });

  // The guard still catches a name-pattern match even when the catalogue cannot be read.
  const unreachable = fixture({ env: { MODEL_LOADER_URL: 'http://loader' }, servedCatalogue: async () => null });
  await unreachable.call('PUT', '/api/auto-roles', { fast: 'nomic-embed-text-v1', smart: 'chat-syn' }, 'admin');
  assert.deepEqual(unreachable.sent.pop(), { status: 400, body: { error: 'The fast role needs a chat model; nomic-embed-text-v1 is an embedding, reranking or routing model.' } });
});

test('the model manager proxy is admin-only, validates the path and serves the cached scan', async () => {
  const unset = fixture();
  await unset.call('GET', '/api/model-manager/models', undefined, 'admin');
  assert.deepEqual(unset.sent.pop(), { status: 404, body: { error: 'Model management service is not configured' } });
  const f = fixture({ env: { MODEL_LOADER_URL: 'http://loader/', MODEL_LOADER_TOKEN: 'tok' } });
  await f.call('GET', '/api/model-manager/models');
  assert.deepEqual(f.sent.pop(), { status: 403, body: { error: 'Administrator required for model management' } });
  await f.call('GET', '/api/model-manager/../secret', undefined, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'Invalid path' } });
  await f.call('GET', '/api/model-manager/models', undefined, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { models: ['a'] } });
  assert.equal(f.fetched[0].url, 'http://loader/api/v1/models');
  assert.equal(f.fetched[0].init.headers['X-Model-Loader-Token'], 'tok');
  assert.deepEqual(f.scan.get('models').body, { models: ['a'] }, 'the scan result is cached');
  f.scan.set('models', { at: Date.now() - 6000, body: { models: ['cached'] } });
  await f.call('GET', '/api/model-manager/models', undefined, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { models: ['cached'] } });
  assert.ok(f.headers.some(([k, v]) => k === 'X-Model-Scan' && v === 'cached'));
  assert.equal(f.refreshes(), 1, 'a stale hit is refreshed behind the response');
  assert.equal(f.fetched.length, 1);
  await f.call('POST', '/api/model-manager/sections/x/safe-defaults', '{}', 'admin');
  assert.equal(f.scan.has('models'), false, 'any write through the proxy drops the scan');
  assert.equal(f.fetched.length, 2);
});

test('the model-manager delete proxy rejects a system model by its scanned key, even though keys are opaque', async () => {
  const f = fixture({ env: { MODEL_LOADER_URL: 'http://loader' } });
  f.scan.set('models', { at: Date.now(), body: { models: [
    { key: 'k-laya', modelId: 'laya_multilingual_f16', sections: ['laya_multilingual_f16'] },
    { key: 'k-synthetic', modelId: 'synthetic', sections: ['synthetic'] },
  ] } });
  await f.call('POST', '/api/model-manager/models/delete', { models: ['k-laya'] }, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'System routing model — not deleted' } });
  assert.equal(f.fetched.length, 0, 'the model management service is never called for a blocked delete');
  await f.call('POST', '/api/model-manager/models/delete', { models: ['k-synthetic'] }, 'admin');
  assert.equal(f.sent.pop().status, 200, 'an ordinary model still deletes through the proxy');
  assert.equal(f.fetched.length, 1);
});

// #302 follow-up: on llama.cpp, a folder-configured model (source: 'preset' in modelsInstalled,
// listed only through the folder scan) is deleted through THIS proxy — LibraryTab's DeleteModel
// only calls POST /api/models/delete when canDelete !== false && source !== 'preset'. Without
// the same cleanup running here, #302 stayed broken for every folder model on a live llama.cpp
// engine (the common case), even though the direct /api/models/delete route was fixed.
test('#336: the model-manager delete proxy also refuses the configured embedding model by its scanned key, with 409', async () => {
  const f = fixture({ env: { MODEL_LOADER_URL: 'http://loader', EMBEDDING_MODEL: 'nomic-embed-text-v1' } });
  f.scan.set('models', { at: Date.now(), body: { models: [
    { key: 'k-embed', modelId: 'nomic-embed-text-v1', sections: ['nomic-embed-text-v1'] },
    { key: 'k-synthetic', modelId: 'synthetic', sections: ['synthetic'] },
  ] } });
  await f.call('POST', '/api/model-manager/models/delete', { models: ['k-embed'] }, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 409, body: { error: 'A running sidecar (embedding or reranking) depends on this model — not deleted' } });
  assert.equal(f.fetched.length, 0, 'the model management service is never called for a blocked delete');
  await f.call('POST', '/api/model-manager/models/delete', { models: ['k-synthetic'] }, 'admin');
  assert.equal(f.sent.pop().status, 200, 'an ordinary model still deletes through the proxy');
});

test('the model-manager delete proxy runs the same unload/roles/identity cleanup as /api/models/delete, for a source:"preset" folder model', async () => {
  const forgotten = [];
  const f = fixture({
    env: { MODEL_LOADER_URL: 'http://loader' },
    manager: {
      unload: async (name) => ({ ok: name === 'Folder-Model' }),
      forgetIdentity: (name) => forgotten.push(name),
    },
    initialRoles: { fast: 'Folder-Model', smart: 'keep-smart' },
    initialLastLoaded: 'Folder-Model',
  });
  f.scan.set('models', { at: Date.now(), body: { models: [
    { key: 'f/folder-model.gguf', modelId: 'Folder-Model', sections: ['Folder-Model'] },
  ] } });
  await f.call('POST', '/api/model-manager/models/delete', { models: ['f/folder-model.gguf'] }, 'admin');
  const sent = f.sent.pop();
  assert.equal(sent.status, 200);
  assert.equal(sent.body.unloaded, true, 'the engine model behind the deleted file was unloaded');
  assert.deepEqual(sent.body.rolesCleared, ['fast']);
  assert.deepEqual(f.roles.current, { fast: 'keep-smart', smart: 'keep-smart' }, 'the persisted role config actually fell back, not a stub');
  assert.equal(f.lastLoaded.current, null, 'the deleted model is no longer the no-model-selected default');
  assert.deepEqual(forgotten, ['Folder-Model'], 'the identity cache entry for the deleted engine model was dropped');
  assert.equal(f.scan.has('models'), false, 'the folder scan cache is dropped so the deleted model is not still listed');
});

test('the model-manager delete proxy cleanup covers every section a deleted file backed, and never touches unrelated roles', async () => {
  const unloadedNames = [];
  const f = fixture({
    env: { MODEL_LOADER_URL: 'http://loader' },
    manager: { unload: async (name) => { unloadedNames.push(name); return { ok: true }; } },
    initialRoles: { fast: 'keep', smart: 'section-b' },
  });
  f.scan.set('models', { at: Date.now(), body: { models: [
    { key: 'f/multi.gguf', modelId: 'multi', sections: ['section-a', 'section-b'] },
  ] } });
  await f.call('POST', '/api/model-manager/models/delete', { models: ['f/multi.gguf'] }, 'admin');
  const sent = f.sent.pop();
  assert.equal(sent.status, 200);
  assert.deepEqual(sent.body.rolesCleared, ['smart']);
  assert.deepEqual(new Set(unloadedNames), new Set(['multi', 'section-a', 'section-b']), 'every resolved id (modelId and each section) is offered for unload');
  assert.deepEqual(f.roles.current, { fast: 'keep', smart: 'keep' });
});

test('the model-manager sections proxy rejects delete and rename of a Laya section, never forwarding them', async () => {
  const f = fixture({ env: { MODEL_LOADER_URL: 'http://loader' } });
  f.scan.set('models', { at: Date.now(), body: { models: [
    { key: 'k-laya', modelId: 'laya_multilingual_f16', sections: ['laya_multilingual_f16'] },
    { key: 'k-synthetic', modelId: 'synthetic', sections: ['synthetic'] },
  ] } });
  await f.call('DELETE', '/api/model-manager/sections/laya_multilingual_f16', undefined, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'System routing model — not deleted' } });
  assert.equal(f.fetched.length, 0, 'a blocked delete never reaches the model management service');
  f.scan.set('models', { at: Date.now(), body: { models: [
    { key: 'k-laya', modelId: 'laya_multilingual_f16', sections: ['laya_multilingual_f16'] },
    { key: 'k-synthetic', modelId: 'synthetic', sections: ['synthetic'] },
  ] } });
  await f.call('POST', '/api/model-manager/sections/laya_multilingual_f16/rename', { to: 'renamed' }, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'System routing model — not deleted' } });
  assert.equal(f.fetched.length, 0, 'a blocked rename never reaches the model management service');
  // A cached scan section id that only resolves to Laya through its modelId is caught too.
  f.scan.set('models', { at: Date.now(), body: { models: [
    { key: 'k-router', modelId: 'router_a', sections: ['laya-router-section'] },
  ] } });
  await f.call('DELETE', '/api/model-manager/sections/laya-router-section', undefined, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'System routing model — not deleted' } });
  assert.equal(f.fetched.length, 0);
  f.scan.set('models', { at: Date.now(), body: { models: [
    { key: 'k-synthetic', modelId: 'synthetic', sections: ['synthetic'] },
  ] } });
  await f.call('DELETE', '/api/model-manager/sections/synthetic', undefined, 'admin');
  assert.equal(f.sent.pop().status, 200, 'an ordinary section still deletes through the proxy');
  assert.equal(f.fetched.length, 1);
});

test('#336: the sections proxy refuses to delete the configured embedding model\'s section (409), but still allows renaming it', async () => {
  const f = fixture({ env: { MODEL_LOADER_URL: 'http://loader', EMBEDDING_MODEL: 'nomic-embed-text-v1' } });
  f.scan.set('models', { at: Date.now(), body: { models: [
    { key: 'k-embed', modelId: 'nomic-embed-text-v1', sections: ['nomic-embed-text-v1'] },
  ] } });
  await f.call('DELETE', '/api/model-manager/sections/nomic-embed-text-v1', undefined, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 409, body: { error: 'A running sidecar (embedding or reranking) depends on this model — not deleted' } });
  assert.equal(f.fetched.length, 0, 'a blocked delete never reaches the model management service');
  // Rename is out of scope for this delete guard; it still forwards.
  f.scan.set('models', { at: Date.now(), body: { models: [
    { key: 'k-embed', modelId: 'nomic-embed-text-v1', sections: ['nomic-embed-text-v1'] },
  ] } });
  await f.call('POST', '/api/model-manager/sections/nomic-embed-text-v1/rename', { to: 'renamed' }, 'admin');
  assert.equal(f.sent.pop().status, 200, 'renaming the embedding model section is unaffected by the delete guard');
});

test('any write under /api/models/ drops the scan, and pull/delete/load keep their answers', async () => {
  const f = fixture();
  f.scan.set('models', { at: Date.now(), body: {} });
  await f.call('POST', '/api/models/pull', { checkpoint: 'org/m:q4' }, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { jobId: 'pull-1', modelName: 'user.org/m:q4' } });
  assert.equal(f.scan.has('models'), false);
  await f.call('POST', '/api/models/pull', {}, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'checkpoint required' } });
  await f.call('POST', '/api/models/delete', { name: 'm' }, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 502, body: { error: 'delete failed: 500', unloaded: true } }, 'a failed delete still reports whether the unload before it succeeded (#302 follow-up)');
  await f.call('POST', '/api/models/delete', { name: 'laya_multilingual_f16' }, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'System routing model — not deleted' } });
  await f.call('POST', '/api/models/load', { name: 'm', mtp: true }, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'Use the native preset editor to configure speculative decoding.' } });
  await f.call('POST', '/api/models/unload', { name: 'm' }, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { ok: true } });
  await f.call('POST', '/api/models/load', '{', 'admin');
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'invalid JSON' } });
  const off = fixture({ enabled: false });
  await off.call('POST', '/api/models/load', { name: 'm' }, 'admin');
  assert.deepEqual(off.sent.pop(), { status: 404, body: { error: 'model management is disabled' } });
  await off.call('GET', '/api/models/downloads');
  assert.deepEqual(off.sent.pop(), { status: 200, body: [] });
  await off.call('GET', '/api/models/hardware');
  assert.deepEqual(off.sent.pop(), { status: 404, body: { error: 'Model manager is disabled. Enter a memory plan manually.' } });
});

test('engine-specific routes say what is unavailable and guard the method', async () => {
  const f = fixture();
  await f.call('POST', '/api/models/presets/reload', {}, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 404, body: { error: 'This engine does not use a preset file' } });
  await f.call('GET', '/api/models/presets/reload', undefined, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 405, body: { error: 'Method not allowed' } });
  await f.call('GET', '/api/models/evidence', undefined, 'member', '?model=m');
  assert.deepEqual(f.sent.pop(), { status: 404, body: { error: 'Qualification evidence needs the native engine' } });
  await f.call('GET', '/api/models/autotune', undefined, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 404, body: { error: 'Auto-tune is unavailable' } });
  await f.call('GET', '/api/models/preset', undefined, 'member');
  assert.deepEqual(f.sent.pop(), { status: 403, body: { error: 'Administrator required for shared model profiles' } });
  await f.call('GET', '/api/models/mtp-artifact', undefined, 'member', '?repo=bad');
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'Invalid repository' } });
  await f.call('GET', '/api/models/installed');
  assert.deepEqual(f.sent.pop(), { status: 200, body: [{ name: 'm', loaded: true }] });
  const native = fixture({ manager: { autotune: { status: (model) => ({ status: 200, body: { model, state: 'idle' } }), cancel: () => ({ status: 200, body: { cancelled: true } }) } } });
  await native.call('GET', '/api/models/autotune', undefined, 'admin', '?model=m');
  assert.deepEqual(native.sent.pop(), { status: 200, body: { model: 'm', state: 'idle' } });
  await native.call('GET', '/api/models/autotune/cancel', undefined, 'admin');
  assert.deepEqual(native.sent.pop(), { status: 405, body: { error: 'Method not allowed' } });
  await native.call('POST', '/api/models/autotune/cancel', undefined, 'admin');
  assert.deepEqual(native.sent.pop(), { status: 200, body: { cancelled: true } });
});

test('bulk tuning discovery and start are admin-only and the server owns the queue', async () => {
  const starts = [];
  const f = fixture({ manager: { autotune: {
    untuned: async () => ({ status: 200, body: { models: ['m'], skipped: [] } }),
    start: async (model, options) => { starts.push({ model, options }); return { status: 202, body: { status: 'running' } }; },
  } } });
  await f.call('GET', '/api/models/autotune/untuned');
  assert.equal(f.sent.pop().status, 403);
  await f.call('GET', '/api/models/autotune/untuned', undefined, 'admin');
  assert.deepEqual(f.sent.pop().body.models, ['m']);
  await f.call('POST', '/api/models/autotune', { untuned: true, confirmPause: true, models: ['untrusted'] }, 'admin');
  assert.equal(f.sent.pop().status, 202);
  assert.deepEqual(starts, [{ model: '', options: { confirmPause: true, promptBudgetSeconds: undefined, untuned: true } }]);
  await f.call('POST', '/api/models/autotune/untuned', {}, 'admin');
  assert.equal(f.sent.pop().status, 405);
});

test('starting auto-tune on a system routing model (Laya) is rejected as a 4xx, even requested directly', async () => {
  const f = fixture({ manager: { autotune: {
    untuned: async () => ({ status: 200, body: { models: [], skipped: [{ model: 'laya_multilingual_f16', reason: 'System routing model — not tuned' }] } }),
    start: async (model) => model === 'laya_multilingual_f16'
      ? { status: 400, body: { error: 'System routing model — not tuned' } }
      : { status: 202, body: { status: 'running' } },
  } } });
  await f.call('POST', '/api/models/autotune', { model: 'laya_multilingual_f16', confirmPause: true }, 'admin');
  const sent = f.sent.pop();
  assert.equal(sent.status, 400);
  assert.equal(sent.body.error, 'System routing model — not tuned');
});

test('resume is admin-only, POST-only and passes renewed pause confirmation', async () => {
  const calls = [];
  const f = fixture({ manager: { autotune: {
    resume: async options => { calls.push(options); return { status: options.confirmPause ? 202 : 400, body: { resumed: options.confirmPause } }; },
  } } });
  await f.call('POST', '/api/models/autotune/resume', { confirmPause: true });
  assert.equal(f.sent.pop().status, 403);
  await f.call('GET', '/api/models/autotune/resume', undefined, 'admin');
  assert.equal(f.sent.pop().status, 405);
  await f.call('POST', '/api/models/autotune/resume', {}, 'admin');
  assert.equal(f.sent.pop().status, 400);
  await f.call('POST', '/api/models/autotune/resume', { confirmPause: true }, 'admin');
  assert.equal(f.sent.pop().status, 202);
  assert.deepEqual(calls, [{ confirmPause: undefined }, { confirmPause: true }]);
  const speedOnly = fixture({ manager: { autotune: { start: () => ({ status: 202, body: {} }) } } });
  await speedOnly.call('POST', '/api/models/autotune/resume', { confirmPause: true }, 'admin');
  assert.deepEqual(speedOnly.sent.pop(), { status: 404, body: { error: 'Resume is unavailable' } });
});

test('the default model mode round-trips, and only an explicit apply switches existing projects', async () => {
  let saves = 0;
  const workspace = { userId: 'u1', preferences: {}, projects: [{ id: 'a', routing: 'manual' }, { id: 'b', routing: 'auto' }],
    savePreferences() {}, saveProjects() { saves += 1; } };
  const f = fixture({ workspace });
  await f.call('GET', '/api/routing-default');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { routing: 'auto' } });
  await f.call('PUT', '/api/routing-default', { routing: 'manual' });
  assert.deepEqual(f.sent.pop(), { status: 200, body: { routing: 'manual', updated: 0 } });
  assert.equal(workspace.projects[1].routing, 'auto', 'changing the default alone rewrites nothing');
  await f.call('PUT', '/api/routing-default', { routing: 'auto', applyToExisting: true });
  assert.deepEqual(f.sent.pop(), { status: 200, body: { routing: 'auto', updated: 1 } });
  assert.deepEqual(workspace.projects.map((p) => p.routing), ['auto', 'auto']);
  assert.equal(saves, 1);
  await f.call('PUT', '/api/routing-default', { routing: 'fast' });
  assert.equal(f.sent.pop().status, 400);
});

test('deleting a loaded model unloads first, clears its auto-role and the last-loaded default, and reports what changed', async () => {
  const calls = [];
  const f = fixture({
    manager: {
      unload: async (name) => { calls.push(['unload', name]); return { ok: true }; },
      deleteModel: async (name) => { calls.push(['delete', name]); return { ok: true, status: 200 }; },
    },
    modelsInstalled: async () => [{ name: 'm', loaded: true }, { name: 'other', loaded: false }],
    initialRoles: { fast: 'm', smart: 'other' },
    initialLastLoaded: 'm',
  });
  await f.call('POST', '/api/models/delete', { name: 'm' }, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { ok: true, unloaded: true, rolesCleared: ['fast'] } });
  assert.deepEqual(calls, [['unload', 'm'], ['delete', 'm']], 'unload happens before delete, in that order');
  assert.deepEqual(f.roles.current, { fast: 'other', smart: 'other' }, 'the fast role falls back to the still-configured smart model');
  assert.equal(f.lastLoaded.current, null, 'the deleted model is no longer the no-model-selected default');
});

test('deleting a model that is not loaded skips unload but still deletes and clears roles', async () => {
  const calls = [];
  const f = fixture({
    manager: {
      unload: async (name) => { calls.push(['unload', name]); return { ok: true }; },
      deleteModel: async (name) => { calls.push(['delete', name]); return { ok: true, status: 200 }; },
    },
    modelsInstalled: async () => [{ name: 'm', loaded: false }],
    initialRoles: { fast: 'f', smart: 'm', vision: 'm' },
  });
  await f.call('POST', '/api/models/delete', { name: 'm' }, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { ok: true, unloaded: false, rolesCleared: ['smart', 'vision'] } });
  assert.deepEqual(calls, [['delete', 'm']], 'an already-unloaded model is never sent an unload call');
  assert.deepEqual(f.roles.current, { fast: 'f', smart: 'f' }, 'smart falls back to fast, and the optional vision role is dropped rather than left dangling');
});

test('deleting a model prefers manager.removeModel (one mutate gate) over separate unload+deleteModel calls, when the manager offers it', async () => {
  const calls = [];
  const f = fixture({
    manager: {
      removeModel: async (name) => { calls.push(['removeModel', name]); return { ok: true, status: 200, unloaded: true }; },
      unload: async (name) => { calls.push(['unload', name]); return { ok: true }; },
      deleteModel: async (name) => { calls.push(['delete', name]); return { ok: true, status: 200 }; },
    },
    modelsInstalled: async () => [{ name: 'm', loaded: true }],
  });
  await f.call('POST', '/api/models/delete', { name: 'm' }, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { ok: true, unloaded: true, rolesCleared: [] } });
  assert.deepEqual(calls, [['removeModel', 'm']], 'removeModel is called instead of separate unload/deleteModel calls');
});

test('a failed delete through removeModel reports its own unloaded value in the 502 body', async () => {
  const f = fixture({
    manager: { removeModel: async () => ({ ok: false, status: 409, unloaded: true }) },
    modelsInstalled: async () => [{ name: 'm', loaded: true }],
  });
  await f.call('POST', '/api/models/delete', { name: 'm' }, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 502, body: { error: 'delete failed: 409', unloaded: true } });
});

test('deleting a model tolerates the manager reporting "not loaded" on unload and still deletes', async () => {
  const f = fixture({
    manager: {
      unload: async () => ({ ok: false, status: 404 }),
      deleteModel: async () => ({ ok: true, status: 200 }),
    },
    modelsInstalled: async () => [{ name: 'm', loaded: true }],
  });
  await f.call('POST', '/api/models/delete', { name: 'm' }, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { ok: true, unloaded: false, rolesCleared: [] } });
});

test('deleting an unknown model 404s and never reaches unload or delete', async () => {
  const calls = [];
  const f = fixture({
    manager: {
      unload: async () => { calls.push('unload'); return { ok: true }; },
      deleteModel: async () => { calls.push('delete'); return { ok: true, status: 200 }; },
    },
    modelsInstalled: async () => [{ name: 'other', loaded: false }],
  });
  await f.call('POST', '/api/models/delete', { name: 'gone' }, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 404, body: { error: 'model not found: gone' } });
  assert.deepEqual(calls, []);
});

test('a system model is still refused before any unload or delete call, on both engine kinds', async () => {
  const llama = fixture({ manager: { unload: async () => ({ ok: true }), deleteModel: async () => ({ ok: true, status: 200 }) } });
  await llama.call('POST', '/api/models/delete', { name: 'laya_multilingual_f16' }, 'admin');
  assert.deepEqual(llama.sent.pop(), { status: 400, body: { error: 'System routing model — not deleted' } });

  const python = fixture({ kind: 'lemonade', manager: { unload: async () => ({ ok: true }), deleteModel: async () => ({ ok: true, status: 200 }) } });
  await python.call('POST', '/api/models/delete', { name: 'laya_multilingual_f16' }, 'admin');
  assert.deepEqual(python.sent.pop(), { status: 400, body: { error: 'System routing model — not deleted' } });
});

test('#336: deleting the configured embedding model (or reranker) 409s before any unload/delete call, on both engine kinds', async () => {
  const calls = [];
  const manager = {
    unload: async () => { calls.push('unload'); return { ok: true }; },
    deleteModel: async () => { calls.push('delete'); return { ok: true, status: 200 }; },
  };
  const llama = fixture({ env: { EMBEDDING_MODEL: 'nomic-embed-text-v1' }, manager, modelsInstalled: async () => [{ name: 'nomic-embed-text-v1', loaded: true }] });
  await llama.call('POST', '/api/models/delete', { name: 'nomic-embed-text-v1' }, 'admin');
  assert.deepEqual(llama.sent.pop(), { status: 409, body: { error: 'A running sidecar (embedding or reranking) depends on this model — not deleted' } });
  assert.deepEqual(calls, [], 'never unloaded or deleted');

  // EMBED_MODEL is the fallback name (rag.cjs's own precedence), and a reranker only counts
  // once the feature is actually on.
  const rerank = fixture({
    env: { EMBED_MODEL: 'nomic-embed-text-v1', NOEVIA_FEATURE_RAG_RERANK: '1', RERANK_MODEL: 'qwen3-reranker-0.6b-q8_0' },
    modelsInstalled: async () => [{ name: 'qwen3-reranker-0.6b-q8_0', loaded: false }],
  });
  await rerank.call('POST', '/api/models/delete', { name: 'qwen3-reranker-0.6b-q8_0' }, 'admin');
  assert.deepEqual(rerank.sent.pop(), { status: 409, body: { error: 'A running sidecar (embedding or reranking) depends on this model — not deleted' } });

  const rerankOff = fixture({
    env: { RERANK_MODEL: 'qwen3-reranker-0.6b-q8_0' },
    manager: { unload: async () => ({ ok: true }), deleteModel: async () => ({ ok: true, status: 200 }) },
    modelsInstalled: async () => [{ name: 'qwen3-reranker-0.6b-q8_0', loaded: false }],
  });
  await rerankOff.call('POST', '/api/models/delete', { name: 'qwen3-reranker-0.6b-q8_0' }, 'admin');
  assert.equal(rerankOff.sent.pop().status, 200, 'RERANK_MODEL alone (feature off) does not protect it');

  // A neutral id resolving to the embedding model through the llama.cpp router listing is caught too.
  const python = fixture({
    kind: 'lemonade',
    env: { EMBEDDING_MODEL: 'nomic-embed-text-v1' },
    manager,
    modelsInstalled: async () => [{ name: 'nomic-embed-text-v1', loaded: true }],
  });
  await python.call('POST', '/api/models/delete', { name: 'nomic-embed-text-v1' }, 'admin');
  assert.deepEqual(python.sent.pop(), { status: 409, body: { error: 'A running sidecar (embedding or reranking) depends on this model — not deleted' } });

  // EMBEDDING_MODEL=default (the .env.example placeholder) protects nothing.
  const placeholder = fixture({
    env: { EMBEDDING_MODEL: 'default' },
    manager: { unload: async () => ({ ok: true }), deleteModel: async () => ({ ok: true, status: 200 }) },
    modelsInstalled: async () => [{ name: 'default', loaded: false }],
  });
  await placeholder.call('POST', '/api/models/delete', { name: 'default' }, 'admin');
  assert.equal(placeholder.sent.pop().status, 200);
});

test('the python model-manager branch (no /models listing check) still unloads, deletes and clears roles', async () => {
  const calls = [];
  const f = fixture({
    kind: 'lemonade',
    manager: {
      unload: async (name) => { calls.push(['unload', name]); return { ok: true }; },
      deleteModel: async (name) => { calls.push(['delete', name]); return { ok: true, status: 200 }; },
    },
    modelsInstalled: async () => [{ name: 'm', loaded: true }],
    initialRoles: { fast: 'm', smart: 'other' },
  });
  await f.call('POST', '/api/models/delete', { name: 'm' }, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { ok: true, unloaded: true, rolesCleared: ['fast'] } });
  assert.deepEqual(calls, [['unload', 'm'], ['delete', 'm']]);
});

test('the benchmark start proxy refuses non-chat models with 400 and forwards chat-only suites (#206)', async () => {
  const f = fixture({ env: { MODEL_LOADER_URL: 'http://loader' }, catalogue: [{ name: 'chat-syn', labels: [] }, { name: 'vec-syn', labels: ['embeddings'] }] });
  for (const alias of ['vec-syn', 'nomic-embed-text-v1', 'qwen3-reranker-0.6b-q8_0', 'laya_multilingual_f16']) {
    await f.call('POST', '/api/model-manager/benchmark/start', { backend: 'b', aliases: ['chat-syn', alias], promptIds: [1], reps: 1 }, 'admin');
    const out = f.sent.pop();
    assert.equal(out.status, 400, alias);
    assert.match(out.body.error, new RegExp(alias.replace(/[.]/g, '\\.')));
  }
  assert.equal(f.fetched.length, 0, 'a refused suite never reaches the model management service');
  await f.call('POST', '/api/model-manager/benchmark/start', { backend: 'b', aliases: ['chat-syn'], promptIds: [1], reps: 1 }, 'admin');
  assert.equal(f.sent.pop().status, 200);
  assert.equal(f.fetched.length, 1);
});

test('the memory estimate is admin-only, read-only and validates the model name (#204)', async () => {
  const seen = [];
  const f = fixture({ manager: { estimateMemory: async (m) => { seen.push(m); return { ok: true, status: 200, body: { model: m, rows: [] } }; } } });
  await f.call('GET', '/api/models/estimate', undefined, 'member', '?model=m');
  assert.equal(f.sent.pop().status, 403);
  await f.call('POST', '/api/models/estimate', {}, 'admin', '?model=m');
  assert.equal(f.sent.pop().status, 405);
  await f.call('GET', '/api/models/estimate', undefined, 'admin', '');
  assert.equal(f.sent.pop().status, 400);
  await f.call('GET', '/api/models/estimate', undefined, 'admin', '?model=m');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { model: 'm', rows: [] } });
  assert.deepEqual(seen, ['m']);
  assert.equal(f.scan.size, 0);
  const none = fixture();
  await none.call('GET', '/api/models/estimate', undefined, 'admin', '?model=m');
  assert.equal(none.sent.pop().status, 404);
  const boom = fixture({ manager: { estimateMemory: async () => { throw Error('/secret/path exploded'); } } });
  const orig = console.error; console.error = () => {};
  try { await boom.call('GET', '/api/models/estimate', undefined, 'admin', '?model=m'); } finally { console.error = orig; }
  assert.deepEqual(boom.sent.pop(), { status: 500, body: { error: 'Could not estimate memory for this model.' } });
});

test('evidence import (#266) is admin-only, validates the model, and always reports current evidence back', async () => {
  const calls = [];
  const f = fixture({
    manager: {
      importEvidence: async (model, opts) => { calls.push([model, opts]); return { ok: true }; },
      evidence: async (model) => ({ status: 200, body: { model, external: { category: 'external_model_card', state: 'reported' } } }),
    },
  });
  await f.call('POST', '/api/models/evidence/import', { model: 'm' }, 'member');
  assert.deepEqual(f.sent.pop(), { status: 403, body: { error: 'administrator required' } });
  await f.call('GET', '/api/models/evidence/import', { model: 'm' }, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 405, body: { error: 'Method not allowed' } });
  await f.call('POST', '/api/models/evidence/import', {}, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'Choose a model' } });
  await f.call('POST', '/api/models/evidence/import', { model: 'm', checkpoint: 'acme/model-7b' }, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { model: 'm', external: { category: 'external_model_card', state: 'reported' } } });
  assert.deepEqual(calls, [['m', { checkpoint: 'acme/model-7b' }]]);

  const none = fixture();
  await none.call('POST', '/api/models/evidence/import', { model: 'm' }, 'admin');
  assert.deepEqual(none.sent.pop(), { status: 404, body: { error: 'Model evidence import needs the native engine' } });
});

test('evidence import never throws through the route when the source lookup fails', async () => {
  const f = fixture({
    manager: {
      importEvidence: async () => { throw Error('source unavailable'); },
      evidence: async (model) => ({ status: 200, body: { model, external: { state: 'unavailable' } } }),
    },
  });
  await f.call('POST', '/api/models/evidence/import', { model: 'm' }, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { model: 'm', external: { state: 'unavailable' } } });
});
