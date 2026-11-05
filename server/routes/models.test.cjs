'use strict';
// The model routes over a fake adapter and service: the administrator gate on every write,
// the proxy with its cached folder scan, and the words each refusal keeps. The numbers and
// the role config are models.test.cjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { EventEmitter } = require('node:events');
const { createModelRoutes, STATS_REFUSAL, ROUTING_DEFAULT_REFUSAL, AUTO_ROLES_REFUSAL } = require('./models.cjs');
const { createModelService } = require('../models.cjs');

// A workspace-shaped test double (autoRoles + saveAutoRoles), for tests that pass
// `otherWorkspaces` to check clearRoleReferences fixes every workspace it can see.
function makeWorkspace(autoRoles = null) {
  return { autoRoles, saves: 0, saveAutoRoles() { this.saves += 1; } };
}

function fixture({ env = {}, enabled = true, kind = 'llamacpp', manager = {}, workspace = { userId: 'u1' }, catalogue = [{ name: 'm' }], servedCatalogue = async () => catalogue, modelsInstalled = async () => [{ name: 'm', loaded: true }], initialRoles = null, initialLastLoaded = null, otherWorkspaces = [], inferenceBudget = null, idleUnload = null, sweepGuardOptions, fetchReply = null, machineModels = undefined } = {}) {
  const sent = [], headers = [], fetched = [], invalidations = [];
  let lastRes = null;
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
    fetchJson: async (url, init) => { fetched.push({ url, init }); return fetchReply ? fetchReply(url, init) : { ok: true, status: 200, body: { models: ['a'] } }; },
    env, modelManager, inferenceBudget, idleUnload, sweepGuardOptions, ...(machineModels ? { machineModels } : {}),
    missingRoles: (r, catalogue) => ({ roles: r, catalogue }),
    currentWorkspace: () => workspace,
    service: {
      modelScanCache: scan, refreshModelScan: () => { refreshes += 1; },
      autoRoles: () => roles.current, setAutoRoles: (next) => { roles.current = next; }, ensureRolesLoaded: () => { roles.warmed = true; },
      servedCatalogue, modelsInstalled, invalidateModelReads: () => { invalidations.push(Date.now()); },
      deriveUserModelName: (c) => `user.${c}`,
      lastLoadedModel: () => lastLoaded.current,
      clearLastLoadedModel: (name) => { if (lastLoaded.current === name) lastLoaded.current = null; },
      clearRoleReferences: (name) => roleService.clearRoleReferences(name),
    },
  });
  const call = (method, path, body, role = 'member', search = '') => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
    req.method = method;
    const res = Object.assign(new EventEmitter(), { setHeader: (k, v) => headers.push([k, v]) });
    lastRes = res;
    return routes(req, res, { path, authn: { user: { id: 'u1', role } }, url: new URL(`http://localhost${path}${search}`) });
  };
  return { call, sent, headers, fetched, scan, invalidations, response: () => lastRes, refreshes: () => refreshes, roles, lastLoaded, ready: routes.sweepAdopted };
}

test('every write under /api/models/ is refused for members before anything else is looked at', async () => {
  const f = fixture();
  assert.equal(await f.call('POST', '/api/models/anything-at-all'), true);
  assert.deepEqual(f.sent.pop(), { status: 403, body: { error: 'administrator required' } });
  assert.equal(await f.call('HEAD', '/api/models/downloads'), true, 'the legacy HEAD stays open to members');
  assert.deepEqual(f.sent.pop(), { status: 200, body: [{ id: 'j1', model: 'm', progress: 0.4, status: 'running' }] });
  assert.equal(await f.call('GET', '/api/model'), false);
  assert.equal(await f.call('DELETE', '/api/auto-roles'), false, 'an unhandled method keeps falling through');
});

test('the roles round-trip and warm up; the front\'s model reads are not answered here (#2187)', async () => {
  const f = fixture({ env: { MODEL_LOADER_URL: 'http://loader' } });
  // GET /api/models/capabilities and /hardware are the Rust front's (rust-models.cjs refuses them
  // before this module); nothing here answers them.
  assert.equal(await f.call('GET', '/api/models/capabilities', undefined, 'admin'), false);
  assert.equal(await f.call('GET', '/api/models/hardware', undefined, 'admin'), false);
  await f.call('PUT', '/api/models/hardware', {}, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 405, body: { error: 'Method not allowed' } }, 'the hardware path\'s other methods keep their 405');
  // The GET is the Rust front's (#2190 close-out, rust-auto-roles.cjs); the PUT is still this module's.
  await f.call('GET', '/api/auto-roles');
  assert.deepEqual(f.sent.pop(), { status: 503, body: AUTO_ROLES_REFUSAL });
  assert.equal(f.sent.length, 0);
  await f.call('PUT', '/api/auto-roles', { fast: ' m ', smart: 'm' }, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { configured: true, roles: { fast: 'm', smart: 'm', vision: '', code: '' } } });
  assert.equal(f.roles.warmed, true, 'an admin save warms the roles up');
  await f.call('PUT', '/api/auto-roles', { fast: 'f' });
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'both fast and smart model names are required' } });
  await f.call('PUT', '/api/auto-roles', '{');
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'invalid JSON' } });  for (const body of ['null', '7', '[]']) {
    await f.call('PUT', '/api/auto-roles', body);
    assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'request body must be a JSON object' } }, `a ${body} body is the client's mistake (#796)`);
  }
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

test('remaining model manager proxy paths preserve administrator/config/path/token and write invalidation',async()=>{
 const unset=fixture();await unset.call('GET','/api/model-manager/sections',undefined,'admin');assert.equal(unset.sent.pop().status,404);
 const f=fixture({env:{MODEL_LOADER_URL:'http://loader/',MODEL_LOADER_TOKEN:'tok'}});
 await f.call('GET','/api/model-manager/sections');assert.equal(f.sent.pop().status,403);
 await f.call('GET','/api/model-manager/../secret',undefined,'admin');assert.equal(f.sent.pop().status,400);
 await f.call('GET','/api/model-manager/sections',undefined,'admin');assert.equal(f.fetched[0].url,'http://loader/api/v1/sections');assert.equal(f.fetched[0].init.headers['X-Model-Loader-Token'],'tok');
 f.scan.set('models',{body:{models:['existing']}});await f.call('POST','/api/model-manager/sections/x/safe-defaults','{}','admin');assert.equal(f.scan.has('models'),false);
});

test('the model-manager delete proxy rejects a system model by its scanned key, even though keys are opaque', async () => {
  const f = fixture({ env: { MODEL_LOADER_URL: 'http://loader' } });
  f.scan.set('models', { at: Date.now(), body: { models: [
    { key: 'k-laya', modelId: 'laya_multilingual_f16', sections: ['laya_multilingual_f16'] },
    { key: 'k-synthetic', modelId: 'synthetic', sections: ['synthetic'] },
  ] } });
  await f.call('POST', '/api/model-manager/models/delete', { models: ['k-laya'] }, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'System routing model — not deleted', errorId: 'systemModel', service: 'decision' } });
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
  assert.deepEqual(f.sent.pop(), { status: 409, body: { error: 'A running sidecar (embedding or reranking) depends on this model — not deleted', errorId: 'modelInUse', service: 'embedding' } });
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
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'System routing model — not deleted', errorId: 'systemModel', service: 'decision' } });
  assert.equal(f.fetched.length, 0, 'a blocked delete never reaches the model management service');
  f.scan.set('models', { at: Date.now(), body: { models: [
    { key: 'k-laya', modelId: 'laya_multilingual_f16', sections: ['laya_multilingual_f16'] },
    { key: 'k-synthetic', modelId: 'synthetic', sections: ['synthetic'] },
  ] } });
  await f.call('POST', '/api/model-manager/sections/laya_multilingual_f16/rename', { to: 'renamed' }, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'System routing model — not deleted', errorId: 'systemModel', service: 'decision' } });
  assert.equal(f.fetched.length, 0, 'a blocked rename never reaches the model management service');
  // A cached scan section id that only resolves to Laya through its modelId is caught too.
  f.scan.set('models', { at: Date.now(), body: { models: [
    { key: 'k-router', modelId: 'router_a', sections: ['laya-router-section'] },
  ] } });
  await f.call('DELETE', '/api/model-manager/sections/laya-router-section', undefined, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'System routing model — not deleted', errorId: 'systemModel', service: 'decision' } });
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
  assert.deepEqual(f.sent.pop(), { status: 409, body: { error: 'A running sidecar (embedding or reranking) depends on this model — not deleted', errorId: 'modelInUse', service: 'embedding' } });
  assert.equal(f.fetched.length, 0, 'a blocked delete never reaches the model management service');
  // Rename is out of scope for this delete guard; it still forwards.
  f.scan.set('models', { at: Date.now(), body: { models: [
    { key: 'k-embed', modelId: 'nomic-embed-text-v1', sections: ['nomic-embed-text-v1'] },
  ] } });
  await f.call('POST', '/api/model-manager/sections/nomic-embed-text-v1/rename', { to: 'renamed' }, 'admin');
  assert.equal(f.sent.pop().status, 200, 'renaming the embedding model section is unaffected by the delete guard');
});

test('any write under /api/models/ drops the scan, and migrated writes refuse while load keeps its answer', async () => {
  const f = fixture();
  f.scan.set('models', { at: Date.now(), body: {} });
  await f.call('POST', '/api/models/pull', { checkpoint: 'synthetic/repo:Q4' }, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 503, body: { error: 'The Rust front owns model pull and delete.' } });
  assert.equal(f.scan.has('models'), false);
  await f.call('POST', '/api/models/load', { name: 'm', mtp: true }, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'Use the native preset editor to configure speculative decoding.' } });
  await f.call('POST', '/api/models/unload', { name: 'm' }, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { ok: true } });
  await f.call('POST', '/api/models/load', '{', 'admin');
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'invalid JSON' } });
  const off = fixture({ enabled: false });
  await off.call('POST', '/api/models/load', { name: 'm' }, 'admin');
  assert.deepEqual(off.sent.pop(), { status: 404, body: { error: 'model management is disabled' } });
  await off.call('HEAD', '/api/models/downloads');
  assert.deepEqual(off.sent.pop(), { status: 200, body: [] });
});

test('engine-specific routes say what is unavailable and guard the method', async () => {
  const f = fixture();
  // POST /api/models/presets/reload is the Rust front's (#2210; rust-model-maintenance.cjs refuses it before
  // authentication). A POST that reaches this route anyway gets the administrator check and a 405, not a reload.
  await f.call('POST', '/api/models/presets/reload', {}, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 405, body: { error: 'Method not allowed' } });
  await f.call('POST', '/api/models/presets/reload', {}, 'member');
  assert.deepEqual(f.sent.pop(), { status: 403, body: { error: 'administrator required' } });
  await f.call('GET', '/api/models/presets/reload', undefined, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 405, body: { error: 'Method not allowed' } });
  await f.call('GET', '/api/models/presets/reload', undefined, 'member');
  assert.deepEqual(f.sent.pop(), { status: 403, body: { error: 'Administrator required for shared model profiles' } });
  await f.call('POST', '/api/models/autotune', undefined, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 404, body: { error: 'Auto-tune is unavailable' } });
  await f.call('GET', '/api/models/preset', undefined, 'member');
  assert.deepEqual(f.sent.pop(), { status: 403, body: { error: 'Administrator required for shared model profiles' } });
  await f.call('GET', '/api/models/mtp-artifact', undefined, 'member', '?repo=bad');
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'Invalid repository' } });
  await f.call('POST', '/api/models/installed', undefined, 'admin');
  assert.equal(f.sent.pop().status, 405, 'only the front lists, and it lists on GET');
  const native = fixture({ manager: { autotune: { statusFacts: () => assert.fail('Node must not compose public GET status') } } });
  await native.call('GET', '/api/models/autotune', undefined, 'admin', '?model=m');
  assert.deepEqual(native.sent.pop(), { status: 405, body: { error: 'Method not allowed' } });
});

test('bulk tuning discovery and start are admin-only and the server owns the queue', async () => {
  const starts = [];
  const f = fixture({ manager: { autotune: {
    start: async (model, options) => { starts.push({ model, options }); return { status: 202, body: { status: 'running' } }; },
  } } });
  await f.call('POST', '/api/models/autotune', { untuned: true, confirmPause: true, models: ['untrusted'] }, 'admin');
  assert.equal(f.sent.pop().status, 202);
  assert.deepEqual(starts, [{ model: '', options: { confirmPause: true, promptBudgetSeconds: undefined, untuned: true } }]);
});

test('starting auto-tune on a system routing model (Laya) is rejected as a 4xx, even requested directly', async () => {
  const f = fixture({ manager: { autotune: {
    start: async (model) => model === 'laya_multilingual_f16'
      ? { status: 400, body: { error: 'System routing model — not tuned' } }
      : { status: 202, body: { status: 'running' } },
  } } });
  await f.call('POST', '/api/models/autotune', { model: 'laya_multilingual_f16', confirmPause: true }, 'admin');
  const sent = f.sent.pop();
  assert.equal(sent.status, 400);
  assert.equal(sent.body.error, 'System routing model — not tuned');
});


test('the default model mode saves, and only an explicit apply switches existing projects', async () => {
  let saves = 0;
  const workspace = { userId: 'u1', preferences: {}, projects: [{ id: 'a', routing: 'manual' }, { id: 'b', routing: 'auto' }],
    savePreferences() {}, saveProjects() { saves += 1; } };
  const f = fixture({ workspace });
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

test('#1071: GET /api/routing-default is the Rust front\'s, so Node always refuses it before reading the workspace; PUT stays Node\'s', async () => {
  let reads = 0;
  // Reading `preferences` is what a workspace-backed answer does; counting it shows whether the refused GET touched the workspace.
  const workspace = { userId: 'u1', projects: [], get preferences() { reads += 1; return { defaultRouting: 'manual' }; }, set preferences(v) { this.stored = v; }, savePreferences() {}, saveProjects() {} };
  // No environment hands it back to Node, a leftover retired switch included.
  for (const env of [{}, { NOEVIA_RUST_ROUTING_DEFAULT: '0' }, { NOEVIA_FRONT: 'node' }, { NOEVIA_FRONT: 'rust', NOEVIA_RUST_AUTH: '1', NOEVIA_RUST_ROUTING_DEFAULT: '1', NOEVIA_RUST_ROUTING_DEFAULT_CONFIRMED: '1' }]) {
    const f = fixture({ env, workspace });
    await f.call('GET', '/api/routing-default');
    assert.deepEqual(f.sent.pop(), { status: 503, body: ROUTING_DEFAULT_REFUSAL }, JSON.stringify(env));
  }
  assert.equal(reads, 0, 'the refused GET never reads the workspace');
  const f = fixture({ workspace });
  await f.call('PUT', '/api/routing-default', { routing: 'auto' });
  assert.equal(f.sent.pop().status, 200, 'PUT keeps answering in Node');
});

test('migrated pull and delete refuse direct Node calls without invoking adapters',async()=>{const f=fixture({manager:{pull:()=>assert.fail(),removeModel:()=>assert.fail(),deleteModel:()=>assert.fail()}});for(const path of ['/api/models/pull','/api/models/delete']){await f.call('POST',path,'malformed','admin');assert.deepEqual(f.sent.pop(),{status:503,body:{error:'The Rust front owns model pull and delete.'}});}});

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

test('GET of the estimate and the suggestion is the Rust front\'s; their other methods keep the admin check and 405 (#2189)', async () => {
  const seen = [];
  const f = fixture({ manager: { estimateMemory: async (m) => { seen.push(m); return { ok: true, status: 200, body: {} }; }, suggestPreset: async (m) => { seen.push(m); return { ok: true, status: 200, body: {} }; } } });
  for (const p of ['/api/models/estimate', '/api/models/preset/suggest']) {
    await f.call('HEAD', p, undefined, 'member', '?model=m');
    assert.deepEqual(f.sent.pop(), { status: 403, body: { error: 'Administrator required for shared model profiles' } }, p);
    await f.call('POST', p, {}, 'member', '?model=m');
    assert.deepEqual(f.sent.pop(), { status: 403, body: { error: 'administrator required' } }, p);
    for (const m of ['POST', 'PUT', 'HEAD']) {
      await f.call(m, p, {}, 'admin', '?model=m');
      assert.deepEqual(f.sent.pop(), { status: 405, body: { error: 'Method not allowed' } }, `${m} ${p}`);
    }
  }
  assert.deepEqual(seen, [], 'no manager sizing call is left in the route');
});

test('evidence import (#266, #2210) is the Rust front\'s: a POST that reaches this route is not imported', async () => {
  const calls = [];
  const f = fixture({ manager: { importEvidence: async (model, opts) => { calls.push([model, opts]); return { ok: true }; }, evidence: async (model) => ({ status: 200, body: { model } }) } });
  await f.call('POST', '/api/models/evidence/import', { model: 'm' }, 'member');
  assert.deepEqual(f.sent.pop(), { status: 403, body: { error: 'administrator required' } });
  await f.call('GET', '/api/models/evidence/import', { model: 'm' }, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 405, body: { error: 'Method not allowed' } });
  await f.call('POST', '/api/models/evidence/import', { model: 'm' }, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 405, body: { error: 'Method not allowed' } });
  assert.deepEqual(calls, [], 'the front does the import, not this route');
});

test('#548: load and unload refuse Laya and the in-use sidecar models with 409 and never reach the engine', async () => {
  const calls = [];
  const f = fixture({ env: { EMBEDDING_MODEL: 'nomic-embed-text-v1', NOEVIA_FEATURE_RAG_RERANK: '1', RERANK_MODEL: 'qwen3-reranker-0.6b-q8_0' },
    manager: { load: async (n) => { calls.push(['load', n]); return { ok: true }; }, unload: async (n) => { calls.push(['unload', n]); return { ok: true }; } } });
  for (const verb of ['load', 'unload']) {
    for (const name of ['laya_multilingual_f16', 'nomic-embed-text-v1', 'qwen3-reranker-0.6b-q8_0']) {
      await f.call('POST', `/api/models/${verb}`, { name }, 'admin');
      const sent = f.sent.pop();
      assert.equal(sent.status, 409, `${verb} ${name}`);
      assert.match(sent.body.error, /not loaded or unloaded here/);
    }
  }
  assert.deepEqual(calls, []);
  await f.call('POST', '/api/models/load', { name: 'chat-7b' }, 'admin');
  assert.equal(f.sent.pop().status, 200, 'an ordinary model still loads');
  await f.call('POST', '/api/models/unload', { name: 'chat-7b' }, 'admin');
  assert.equal(f.sent.pop().status, 200);
  assert.deepEqual(calls, [['load', 'chat-7b'], ['unload', 'chat-7b']]);
});

test('#545: load refuses a preset whose model file is missing with 409, but unload is still allowed', async () => {
  const calls = [];
  const f = fixture({ modelsInstalled: async () => [{ name: 'ghost', missingFile: true, failed: true }, { name: 'ok', loaded: false }],
    manager: { load: async (n) => { calls.push(['load', n]); return { ok: true }; }, unload: async (n) => { calls.push(['unload', n]); return { ok: true }; } } });
  await f.call('POST', '/api/models/load', { name: 'ghost' }, 'admin');
  const sent = f.sent.pop();
  assert.equal(sent.status, 409);
  assert.match(sent.body.error, /not in the models folder/);
  assert.deepEqual(calls, []);
  await f.call('POST', '/api/models/unload', { name: 'ghost' }, 'admin');
  assert.equal(f.sent.pop().status, 200);
  await f.call('POST', '/api/models/load', { name: 'ok' }, 'admin');
  assert.equal(f.sent.pop().status, 200);
});

// #697: the inference memory budget setting, the estimates beside it, and the two proxied paths
// that would otherwise reach the engine or size past the budget.
test('the inference budget is saved by an administrator; its GET is the Rust front\'s', async () => {
  const saved = [];
  const inferenceBudget = { get: () => ({ budgetGib: 12, source: 'deployment', minGib: 2, maxGib: 25 }),
    save: (body, actor) => { if (body.budgetGib > 25) throw Object.assign(Error('Enter a budget from 2 to 25 GiB, in steps of 0.1.'), { status: 400, messageId: 'invalidBudget', minGib: 2, maxGib: 25 }); saved.push([body, actor]); return { budgetGib: body.budgetGib, source: 'admin', minGib: 2, maxGib: 25 }; } };
  const f = fixture({ inferenceBudget });
  await f.call('PUT', '/api/models/inference-budget', { budgetGib: 20 });
  assert.equal(f.sent.pop().status, 403);
  await f.call('PUT', '/api/models/inference-budget', { budgetGib: 20 }, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { budgetGib: 20, source: 'admin', minGib: 2, maxGib: 25 } });
  assert.deepEqual(saved, [[{ budgetGib: 20 }, 'u1']]);
  await f.call('PUT', '/api/models/inference-budget', { budgetGib: 40 }, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'Enter a budget from 2 to 25 GiB, in steps of 0.1.', errorId: 'invalidBudget', minGib: 2, maxGib: 25 } });
  await f.call('DELETE', '/api/models/inference-budget', undefined, 'admin');
  assert.equal(f.sent.pop().status, 405);
});

// noevia#1863: the idle unload time is an administrator setting.
test('#1863 the idle unload time is read and saved by administrators only', async () => {
  const saved = [];
  const idleUnload = { save: async (body, actor) => { if (body.seconds === 60) throw Object.assign(Error('Choose Never or a time from 5 minutes to 24 hours.'), { status: 400, errorId: 'idleUnloadInvalid', minSeconds: 300, maxSeconds: 86400 }); saved.push([body, actor]); return { seconds: body.seconds, source: 'setting', apply: { state: 'applied' } }; } };
  const f = fixture({ idleUnload });
  for (const [method, body] of [['GET'], ['PUT', { seconds: 3600 }]]) {
    await f.call(method, '/api/models/idle-unload', body);
    assert.equal(f.sent.pop().status, 403, `members cannot ${method}`);
  }
  assert.deepEqual(saved, []);
  await f.call('GET', '/api/models/idle-unload', undefined, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 405, body: { error: 'Method not allowed' } });
  assert.ok(f.headers.some(([k, v]) => k === 'Cache-Control' && v === 'no-store'));
  await f.call('PUT', '/api/models/idle-unload', { seconds: 3600 }, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { seconds: 3600, source: 'setting', apply: { state: 'applied' } } });
  assert.deepEqual(saved, [[{ seconds: 3600 }, 'u1']]);
  await f.call('PUT', '/api/models/idle-unload', { seconds: 60 }, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'Choose Never or a time from 5 minutes to 24 hours.', errorId: 'idleUnloadInvalid', minSeconds: 300, maxSeconds: 86400 } });
  await f.call('PUT', '/api/models/idle-unload', '{bad', 'admin');
  assert.equal(f.sent.pop().status, 400);
  await f.call('DELETE', '/api/models/idle-unload', undefined, 'admin');
  assert.equal(f.sent.pop().status, 405);
  const none = fixture();
  await none.call('GET', '/api/models/idle-unload', undefined, 'admin');
  assert.equal(none.sent.pop().status, 404);
});

test('a benchmark of an over-budget model is refused before the model manager loads it', async () => {
  const refusal = { error: 'big needs about 30 GiB to load', code: 'inference_budget', budgetGib: 12 };
  const f = fixture({ env: { MODEL_LOADER_URL: 'http://loader' }, catalogue: [{ name: 'small' }, { name: 'big' }],
    manager: { loadRefusal: async (m) => (m === 'big' ? refusal : null) } });
  await f.call('POST', '/api/model-manager/benchmark/start', { aliases: ['small', 'big'] }, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 409, body: refusal });
  assert.equal(f.fetched.length, 0, 'nothing reached the model manager');
  await f.call('POST', '/api/model-manager/benchmark/start', { aliases: ['small'] }, 'admin');
  assert.equal(f.fetched.length, 1);
});

test('the model manager autoconfig is sized against the budget set by the server, not the browser', async () => {
  const f = fixture({ env: { MODEL_LOADER_URL: 'http://loader' }, manager: { sizingBudgetGib: () => 14 } });
  await f.call('GET', '/api/model-manager/sections/chat-syn/autoconfig', undefined, 'admin', '?sessions=1&budget_gib=999');
  assert.equal(f.fetched[0].url, 'http://loader/api/v1/sections/chat-syn/autoconfig?sessions=1&budget_gib=14');
  await f.call('GET', '/api/model-manager/sections/chat-syn', undefined, 'admin', '?x=1');
  assert.equal(f.fetched[1].url, 'http://loader/api/v1/sections/chat-syn?x=1', 'other paths pass through unchanged');
  const none = fixture({ env: { MODEL_LOADER_URL: 'http://loader' }, manager: { sizingBudgetGib: () => 0 } });
  await none.call('GET', '/api/model-manager/sections/chat-syn/autoconfig', undefined, 'admin', '?budget_gib=999');
  assert.equal(none.fetched[0].url, 'http://loader/api/v1/sections/chat-syn/autoconfig', 'a client figure is never forwarded');
});

test('#697: a model manager section save that would exceed the budget is refused before it is forwarded', async () => {
  const seen = [];
  const f = fixture({ env: { MODEL_LOADER_URL: 'http://loader' },
    manager: { presetRefusal: async (name, options) => { seen.push([name, options]); return options['ctx-size'] === '262144' ? { error: 'Not saved: too big', code: 'inference_budget', budgetGib: 12 } : null; } } });
  await f.call('PUT', '/api/model-manager/sections/chat-syn', { baseRevision: 'r', values: { 'ctx-size': '262144', 'cache-type-k': '', jinja: 'true' }, extras: 'LLAMA_ARG_CACHE_RAM = 512\n# note' }, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 409, body: { error: 'Not saved: too big', code: 'inference_budget', budgetGib: 12 } });
  assert.equal(f.fetched.length, 0);
  assert.deepEqual(seen[0], ['chat-syn', { 'ctx-size': '262144', jinja: 'true', LLAMA_ARG_CACHE_RAM: '512' }], 'values and extras, empty values dropped');
  await f.call('PUT', '/api/model-manager/sections/chat-syn', { baseRevision: 'r', values: { 'ctx-size': '8192' } }, 'admin');
  assert.equal(f.fetched.length, 1, 'a fitting save is forwarded');
});

test('#873: the throughput sweep checks every model against the budget and holds the gate while it runs', async () => {
  const { createMaintenanceGate } = require('../inference-maintenance.cjs');
  const { SWEEP_BUSY_ERROR } = require('../benchmark-sweep-guard.cjs');
  const gate = createMaintenanceGate();
  const refusal = { error: 'big needs about 30 GiB to load', code: 'inference_budget', budgetGib: 16 };
  const timers = []; let progress = { active: true }, sweepReply = { ok: true, status: 200, body: { job: { active: true } } };
  const f = fixture({ env: { MODEL_LOADER_URL: 'http://loader' },
    manager: { loadRefusal: async (m) => (m === 'big' ? refusal : null), holdMaintenance: (reason) => gate.hold(reason) },
    fetchReply: (url) => (url.endsWith('/benchmark/progress') ? { ok: true, status: 200, body: { job: progress } } : sweepReply),
    sweepGuardOptions: { setTimer: (fn) => { timers.push(fn); return { unref() {} }; }, clearTimer: () => {} } });
  assert.equal(await f.ready, false, 'no sweep was running at start');
  assert.equal(gate.held(), false); f.fetched.length = 0;
  const sweep = (aliases) => f.call('POST', '/api/model-manager/benchmark/sweep', { backend: 'b', aliases, nPrompt: 512, nGen: 128, depths: '0', reps: 1 }, 'admin');
  // An over-budget model is refused like a load, whichever position it has.
  await sweep(['small', 'big']);
  assert.deepEqual(f.sent.pop(), { status: 409, body: refusal });
  assert.equal(f.fetched.length, 0); assert.equal(gate.held(), false);
  // Not while requests are in flight: the UI shows this message.
  const chat = gate.enter();
  await sweep(['small']);
  assert.deepEqual(f.sent.pop(), { status: 409, body: { error: SWEEP_BUSY_ERROR } });
  assert.equal(f.fetched.length, 0); chat();
  // A refused start releases the gate at once.
  sweepReply = { ok: false, status: 409, body: { detail: 'a benchmark is already running' } };
  await sweep(['small']);
  assert.deepEqual(f.sent.pop(), { status: 409, body: { error: 'a benchmark is already running' } });
  assert.equal(gate.held(), false); assert.equal(timers.length, 0);
  // An accepted sweep pauses chat until the model manager reports it is over.
  sweepReply = { ok: true, status: 200, body: { job: { active: true } } };
  await sweep(['small', 'other']);
  assert.equal(f.sent.pop().status, 200);
  assert.equal(gate.held(), true);
  assert.throws(() => gate.enter(), (e) => e.status === 503 && /throughput sweep/.test(e.message));
  await timers.shift()();
  assert.equal(gate.held(), true, 'still running');
  assert.ok(f.fetched.at(-1).url.endsWith('/api/v1/benchmark/progress'));
  progress = { active: false, status: 'done' };
  await timers.shift()();
  assert.equal(gate.held(), false); assert.equal(timers.length, 0);
  gate.enter()();
  // A lost reply may hide a started sweep: the gate stays until progress says otherwise.
  sweepReply = null; progress = { active: true };
  await sweep(['small']);
  assert.equal(f.sent.pop().status, 502);
  assert.equal(gate.held(), true);
  progress = { active: false };
  await timers.shift()();
  assert.equal(gate.held(), false);
});

test('#873: a sweep still running after a web restart takes the gate back at start', async () => {
  const { createMaintenanceGate } = require('../inference-maintenance.cjs');
  const timers = [];
  const make = (job, gate = createMaintenanceGate()) => {
    let current = job;
    const f = fixture({ env: { MODEL_LOADER_URL: 'http://loader' }, manager: { holdMaintenance: (reason) => gate.hold(reason) },
      fetchReply: (url) => (url.endsWith('/benchmark/progress') ? { ok: true, status: 200, body: { job: current } } : { ok: true, status: 200, body: {} }),
      sweepGuardOptions: { setTimer: (fn) => { timers.push(fn); return { unref() {} }; }, clearTimer: () => {} } });
    return { f, gate, finish: () => { current = { active: false, unit: 'models' }; } };
  };
  const running = make({ active: true, status: 'running', unit: 'models', total: 3, done: 1 });
  assert.equal(await running.f.ready, true);
  assert.equal(running.gate.held(), true);
  assert.throws(() => running.gate.enter(), (e) => e.status === 503 && /throughput sweep/.test(e.message));
  assert.ok(running.f.fetched[0].url.endsWith('/api/v1/benchmark/progress'));
  running.finish(); await timers.shift()();
  assert.equal(running.gate.held(), false);
  // A prompt-suite run (counted in requests) or an idle manager leaves the gate alone.
  const suite = make({ active: true, status: 'running', unit: 'requests', total: 9 });
  assert.equal(await suite.f.ready, false); assert.equal(suite.gate.held(), false);
  const idle = make({ active: false, unit: 'models' });
  assert.equal(await idle.f.ready, false); assert.equal(idle.gate.held(), false);
  // A gate already held (requests in flight cannot be at startup, but a calibration can) is not fought over.
  const busyGate = createMaintenanceGate(); const release = busyGate.hold('calibrating');
  const busy = make({ active: true, unit: 'models', total: 1 }, busyGate);
  assert.equal(await busy.f.ready, false); release();
  assert.equal(timers.length, 0);
});

test('#1158: an invalid size on a model manager section save is a 400 with its code, not a 409 revision conflict', async () => {
  const f = fixture({ env: { MODEL_LOADER_URL: 'http://loader' },
    manager: { presetRefusal: async (name, options) => options['ctx-size'] === '-1'
      ? { error: 'Not saved: ctx-size must be a whole number (0 for the native context) (got "-1").', code: 'invalid_size' } : null } });
  await f.call('PUT', '/api/model-manager/sections/chat-syn', { baseRevision: 'r', values: { 'ctx-size': '-1' } }, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'Not saved: ctx-size must be a whole number (0 for the native context) (got "-1").', code: 'invalid_size' } });
  assert.equal(f.fetched.length, 0, 'nothing is forwarded to the model manager');
});

test('#1233: a model section save with a non-string model path is refused with 400 and never forwarded', async () => {
  const f = fixture({ env: { MODEL_LOADER_URL: 'http://loader' }, manager: { presetRefusal: async () => null } });
  for (const bad of [123, { a: 1 }, ['x'], true]) {
    await f.call('PUT', '/api/model-manager/sections/chat-syn', { baseRevision: 'r', values: { model: bad } }, 'admin');
    const last = f.sent.pop();
    assert.equal(last.status, 400, JSON.stringify(bad)); assert.equal(last.body.code, 'invalid_path');
  }
  await f.call('PUT', '/api/model-manager/sections/chat-syn', { baseRevision: 'r', values: { mmproj: 5 } }, 'admin');
  assert.equal(f.sent.pop().status, 400);
  assert.equal(f.fetched.length, 0);
  await f.call('PUT', '/api/model-manager/sections/chat-syn', { baseRevision: 'r', values: { model: '/models/x.gguf' } }, 'admin');
  assert.equal(f.fetched.length, 1, 'a string path still goes through');
});

test('#1235: aliases of the model path options (m, mm, md, LLAMA_ARG_*) with a non-string value are refused with 400 invalid_path', async () => {
  const f = fixture({ env: { MODEL_LOADER_URL: 'http://loader' }, manager: { presetRefusal: async () => null } });
  const keys = { m: 'model', LLAMA_ARG_MODEL: 'model', '-m': 'model', mm: 'mmproj', LLAMA_ARG_MMPROJ: 'mmproj', md: 'model-draft', LLAMA_ARG_MODEL_DRAFT: 'model-draft', '--model-draft': 'model-draft' };
  for (const [alias, canonical] of Object.entries(keys)) {
    for (const bad of [123, { a: 1 }, ['x'], true]) {
      await f.call('PUT', '/api/model-manager/sections/chat-syn', { baseRevision: 'r', values: { [alias]: bad } }, 'admin');
      const last = f.sent.pop();
      assert.equal(last.status, 400, `${alias} ${JSON.stringify(bad)}`); assert.equal(last.body.code, 'invalid_path');
      assert.match(last.body.error, new RegExp(canonical));
    }
  }
  assert.equal(f.fetched.length, 0, 'nothing is forwarded');
  await f.call('PUT', '/api/model-manager/sections/chat-syn', { baseRevision: 'r', values: { m: '/models/x.gguf', LLAMA_ARG_MMPROJ: '/models/p.gguf' } }, 'admin');
  assert.equal(f.fetched.length, 1, 'string aliases still go through');
});

test('#1249: a null or blank model path is refused (400 invalid_path) under every alias; mmproj and model-draft can still be cleared', async () => {
  const f = fixture({ env: { MODEL_LOADER_URL: 'http://loader' }, manager: { presetRefusal: async () => null } });
  for (const alias of ['model', 'm', 'LLAMA_ARG_MODEL', '-m', '--model']) {
    for (const bad of [null, '', '   ']) {
      await f.call('PUT', '/api/model-manager/sections/chat-syn', { baseRevision: 'r', values: { [alias]: bad } }, 'admin');
      const last = f.sent.pop();
      assert.equal(last.status, 400, `${alias} ${JSON.stringify(bad)}`); assert.equal(last.body.code, 'invalid_path');
    }
  }
  assert.equal(f.fetched.length, 0, 'nothing is forwarded');
  await f.call('PUT', '/api/model-manager/sections/chat-syn', { baseRevision: 'r', values: { mmproj: '', mm: null, 'model-draft': null, md: '' } }, 'admin');
  assert.equal(f.fetched.length, 1, 'clearing mmproj / model-draft still goes through');
});

test('#1071: GET /api/stats is the Rust front\'s, so Node always refuses it before any engine read and answers no other method', async () => {
  const reads = [];
  const count = (name, value) => async () => { reads.push(name); return value; };
  const manager = {
    stats: count('stats', { ok: true, body: { scope: 'engine', tokens_per_second: 9, mtp: [] } }),
    systemStats: count('systemStats', { ok: true, body: { cpu_percent: 1 } }),
    health: count('health', { ok: true, body: { all_models_loaded: [] } }),
    metrics: count('metrics', { ok: false }),
    listModels: count('listModels', { ok: true, body: { data: [] } }),
  };
  for (const env of [{}, { NOEVIA_RUST_STATS: '0' }, { NOEVIA_FRONT: 'rust', NOEVIA_RUST_AUTH: '1', NOEVIA_RUST_STATS: '1', NOEVIA_RUST_STATS_CONFIRMED: '1' }]) {
    const f = fixture({ env: { MODEL_LOADER_URL: 'http://loader', ...env }, manager });
    for (const role of ['member', 'admin']) {
      await f.call('GET', '/api/stats', undefined, role);
      assert.deepEqual(f.sent.pop(), { status: 503, body: STATS_REFUSAL }, JSON.stringify(env));
    }
    for (const method of ['POST', 'HEAD', 'PUT']) {
      await f.call(method, '/api/stats', undefined, 'admin');
      assert.deepEqual(f.sent.pop(), { status: 405, body: { error: 'Method not allowed' } }, method);
    }
  }
  assert.deepEqual(reads, [], 'Node reads nothing from the engine for /api/stats');
  // A role save still drops the model reads Node keeps (the stats share left with the GET).
  const f = fixture({ env: { MODEL_LOADER_URL: 'http://loader' }, manager });
  await f.call('PUT', '/api/auto-roles', { fast: 'm', smart: 'm' }, 'admin');
  assert.equal(f.sent.pop().status, 200);
});




// #1849/#1855 (the machine models and the served-catalogue filter of GET /api/auto-roles) are published for the Rust front:
// rust-auto-roles.test.cjs (autoRolesState) here, noevia-rs tests/auto_roles.rs for the answer.

test('a model or role write drops the shared reads before it and again once its answer is out, so the front\'s snapshot is rebuilt after the write (#2190 review L2)', async () => {
  const f = fixture({ env: { MODEL_LOADER_URL: 'http://loader' } });
  await f.call('PUT', '/api/auto-roles', { fast: 'm', smart: 'm' }, 'admin');
  assert.equal(f.invalidations.length, 1, 'dropped before the write');
  f.response().emit('finish');
  assert.equal(f.invalidations.length, 2, 'dropped again when the answer is out');
  f.response().emit('close');
  f.response().emit('finish');
  assert.equal(f.invalidations.length, 2, 'once, whichever of finish and close comes first');
  // A client that left first is the same write: close alone drops them again.
  await f.call('PUT', '/api/auto-roles', { fast: 'm', smart: 'm' }, 'admin');
  assert.equal(f.invalidations.length, 3);
  f.response().emit('close');
  assert.equal(f.invalidations.length, 4);
  // Reads never register the second drop.
  await f.call('HEAD', '/api/models/downloads');
  assert.equal(f.invalidations.length, 4);
  f.response().emit('finish');
  f.response().emit('close');
  assert.equal(f.invalidations.length, 4, 'a read changes nothing');
});

test('#2276 manager preset writers acquire a hold before forwarding; reads stay available', async () => {
  const calls = [];
  const f = fixture({ env: { MODEL_LOADER_URL: 'http://loader' }, manager: {
    writePresets: async () => { calls.push('hold'); throw Object.assign(Error('busy'), { status: 409, holdRefused: true }); },
  } });
  for (const [method, rest] of [['PUT','models-ini'], ['PUT','idle-unload'], ['PUT','sections/chat-syn'], ['DELETE','sections/chat-syn'], ['POST','sections/chat-syn/rename'], ['POST','sections/chat-syn/safe-defaults']]) {
    await f.call(method, '/api/model-manager/'+rest, { values: {} }, 'admin');
    assert.equal(f.sent.at(-1).status, 409, rest);
    assert.equal(f.sent.at(-1).body.errorId, 'modelsBusy', rest);
    assert.equal(f.sent.at(-1).body.code, 'modelsBusy', 'busy is not a stale revision');
  }
  assert.equal(calls.length, 6);
  assert.deepEqual(f.fetched, [], 'a refused hold never writes');
  await f.call('GET', '/api/model-manager/sections/chat-syn', undefined, 'admin');
  assert.equal(f.sent.at(-1).status, 200);
  assert.equal(calls.length, 6, 'read does not acquire a hold');
});

test('#2276 manager writes retain the hold through the reload and release it on service failure', async () => {
  const steps = []; let held = false, ok = true;
  const f = fixture({ env: { MODEL_LOADER_URL: 'http://loader' }, manager: {
    writePresets: async (write, reloadIf) => {
      steps.push('hold'); held = true;
      try { const written = await write(); if (reloadIf(written)) steps.push('reload'); return { written, reload: { ok: true } }; }
      finally { steps.push('release'); held = false; }
    },
  }, fetchReply: async () => { assert.equal(held, true); steps.push('write'); return { ok, status: ok ? 200 : 503, body: ok ? { revision: 'new' } : { error: 'unavailable' } }; } });
  await f.call('PUT', '/api/model-manager/sections/chat-syn', { values: {} }, 'admin');
  assert.deepEqual(steps, ['hold','write','reload','release']);
  assert.deepEqual(f.sent.at(-1), { status: 200, body: { revision: 'new' } });
  steps.length = 0; ok = false;
  await f.call('POST', '/api/model-manager/sections/chat-syn/safe-defaults', {}, 'admin');
  assert.deepEqual(steps, ['hold','write','release']);
  assert.equal(f.sent.at(-1).status, 503);
  assert.equal(held, false);
});

 test('#2276 encoded separators and dot segments cannot evade preset writer guards', async () => {
  const f = fixture({ env: { MODEL_LOADER_URL: 'http://loader' }, manager: {
    writePresets: async () => { throw Error('invalid path must be refused first'); },
  } });
  for (const rest of ['sections/x/%2e%2e/y','sections/%2E/y','sections%2Fchat-syn%2Fsafe-defaults','sections/x%5cy','sections/%ZZ']) {
    await f.call('PUT', '/api/model-manager/'+rest, { values: {} }, 'admin');
    assert.equal(f.sent.at(-1).status, 400, rest);
  }
  assert.deepEqual(f.fetched, []);
});

 test('#2278 encoded section prefixes obey identity and budget guards before forwarding', async () => {
  const system = fixture({ env: { MODEL_LOADER_URL: 'http://loader' } });
  await system.call('DELETE', '/api/model-manager/%73ections/laya_multilingual_f16', undefined, 'admin');
  assert.equal(system.sent.at(-1).status, 400);
  assert.equal(system.sent.at(-1).body.errorId, 'systemModel');
  assert.deepEqual(system.fetched, []);
  const calls = [];
  const budget = fixture({ env: { MODEL_LOADER_URL: 'http://loader' }, manager: {
    presetRefusal: async (name, options) => { calls.push({ name, options }); return { error: 'too large', code: 'overBudget' }; },
  } });
  await budget.call('PUT', '/api/model-manager/%73ections/chat%20name', { values: { 'ctx-size': '262144' } }, 'admin');
  assert.equal(budget.sent.at(-1).status, 409);
  assert.deepEqual(calls, [{ name: 'chat name', options: { 'ctx-size': '262144' } }]);
  assert.deepEqual(budget.fetched, []);
});

 test('#2278 canonical guard matching preserves encoded section names on the upstream URL', async () => {
  const calls = [];
  const f = fixture({ env: { MODEL_LOADER_URL: 'http://loader' }, manager: {
    presetRefusal: async name => { calls.push(name); return null; },
  } });
  await f.call('PUT', '/api/model-manager/%73ections/chat%25name', { values: {} }, 'admin');
  assert.equal(f.sent.at(-1).status, 200);
  assert.deepEqual(calls, ['chat%name']);
  assert.equal(f.fetched[0].url, 'http://loader/api/v1/%73ections/chat%25name');
});

test('native embedding protection missing or stale refuses all delete entrypoints before mutation', async t => {
  const mod = require('../embedding-service.cjs');
  const prior = mod.current();
  t.after(() => mod.install(prior));
  mod.install({ protectionKnown: () => false, managed: () => false });
  const f = fixture({ env: { MODEL_LOADER_URL: 'http://loader' } });
  for (const [method, route, body] of [
    ['POST', '/api/model-manager/models/delete', { models: ['synthetic'] }],
    ['DELETE', '/api/model-manager/sections/synthetic'],
  ]) {
    await f.call(method, route, body, 'admin');
    assert.equal(f.sent.pop().status, 409, route);
  }
  assert.equal(f.fetched.length, 0);
});

test('#2298 stable saved reranker is protected beside the deployment seed in public model actions', async () => {
  const settings = require('../rerank-settings.cjs');
  const prior = settings.current();
  const env = { NOEVIA_FEATURE_RAG_RERANK: 'true', RERANK_BACKEND: 'llamacpp', RERANK_BASE_URL: 'http://synthetic-rerank', RERANK_MODEL: 'rerank-seed-a', MODEL_LOADER_URL: 'http://synthetic-loader' };
  const store = new Map([[settings.KEY, JSON.stringify({ enabled: true, choice: 'llamacpp:rerank-current-b' })]]);
  settings.install(settings.createRerankSettings({ store, env }));
  let operations = 0;
  const forbidden = async () => { operations++; throw Error('unexpected model operation'); };
  try {
    for (const name of ['rerank-seed-a', 'rerank-current-b']) {
      const f = fixture({ env, manager: { load: forbidden, unload: forbidden, deleteModel: forbidden, request: forbidden } });
      for (const action of ['load', 'unload']) {
        await f.call('POST', `/api/models/${action}`, { name }, 'admin');
        assert.equal(f.sent.at(-1)?.status, 409, `${action} must protect ${name}`);
        if (action === 'delete') assert.equal(f.sent.at(-1).body.service, 'reranker');
      }
      f.scan.set('models', { at: Date.now(), body: { models: [{ key: 'synthetic.gguf', modelId: name, sections: [name] }] } });
      await f.call('DELETE', '/api/model-manager/sections/' + name, undefined, 'admin');
      assert.equal(f.sent.at(-1)?.status, 409, 'section deletion must protect ' + name);
      await f.call('POST', '/api/model-manager/models/delete', { models: ['synthetic.gguf'] }, 'admin');
      assert.equal(f.sent.at(-1)?.status, 409, 'folder deletion must protect ' + name);
      assert.equal(f.fetched.length, 0, 'refusal must precede loader calls');
    }
    assert.equal(operations, 0);
  } finally { settings.install(prior); }
});


test('#2298 unreadable current reranker state refuses unsafe public actions before operations', async () => {
  const settings = require('../rerank-settings.cjs');
  const prior = settings.current();
  const env = { MODEL_LOADER_URL: 'http://synthetic-loader' };
  let operations = 0;
  const forbidden = async () => { operations++; throw Error('unexpected operation'); };
  const { errorResponse } = require('../http.cjs');
  try {
    for (const current of [
      {}, { effectiveEnv() { throw Error('private provider details'); } },
      { effectiveEnv: () => null }, { effectiveEnv: () => [] },
      { effectiveEnv: () => ({ NOEVIA_FEATURE_RAG_RERANK: {}, RERANK_MODEL: 'm' }) },
      { effectiveEnv: () => ({ NOEVIA_FEATURE_RAG_RERANK: true, RERANK_MODEL: {} }) },
    ]) {
      settings.install(current);
      const f = fixture({ env, manager: { load: forbidden, unload: forbidden, deleteModel: forbidden, request: forbidden } });
      f.scan.set('models', { at: Date.now(), body: { models: [{ key: 'synthetic.gguf', modelId: 'm', sections: ['m'] }] } });
      for (const [method, path, body] of [
        ['POST', '/api/models/load', { name: 'm' }],
        ['POST', '/api/models/unload', { name: 'm' }],
        ['DELETE', '/api/model-manager/sections/m'],
        ['POST', '/api/model-manager/models/delete', { models: ['synthetic.gguf'] }],
      ]) {
        // Public /api/models writes drop the scan; restore the synthetic known row for the proxy.
        f.scan.set('models', { at: Date.now(), body: { models: [{ key: 'synthetic.gguf', modelId: 'm', sections: ['m'] }] } });
        await assert.rejects(f.call(method, path, body, 'admin'), (error) => {
          assert.deepEqual(errorResponse(error), { status: 503, body: { error: 'Internal error' } });
          return true;
        });
      }
      assert.equal(f.fetched.length, 0);
    }
    assert.equal(operations, 0);
  } finally { settings.install(prior); }
});
test('download GET pairs an exact refusal with bounded trusted adapter facts', async () => {
  const { refuseOwned } = require('../rust-model-downloads-read.cjs');
  const { createModelDownloadsFacts, PATH } = require('../rust-model-downloads-read-facts.cjs');
  const sent = [];
  const json = (_res, status, body) => sent.push({ status, body });
  const ctx = { parseRequestUrl: req => new URL(req.url, 'http://localhost'), json };
  assert.equal(refuseOwned({ method: 'HEAD', url: '/api/models/downloads' }, {}, ctx), false);
  assert.equal(refuseOwned({ method: 'GET', url: '/api/models/downloads/' }, {}, ctx), false);
  assert.equal(refuseOwned({ method: 'GET', url: '/api/models/downloads?x=1' }, {}, ctx), true);
  assert.equal(sent.pop().status, 503);

  let polls = 0;
  let body = {
    jobs: [{ id: 0, job_id: 'j', percent: Infinity, progress: 0.9, private: 'hidden' }, null, 'text'],
    downloads: [{ id: 'unchosen' }],
  };
  const manager = {
    enabled: true,
    async downloads() {
      polls++;
      return { ok: true, body };
    },
  };
  const bridge = createModelDownloadsFacts({ secret: 'secret', json, manager: () => manager });
  const request = {
    method: 'POST', url: PATH, socket: { remoteAddress: '127.0.0.1' },
    headers: { 'x-noevia-store-token': 'secret' },
  };
  for (const untrusted of [
    { ...request, method: 'GET' },
    { ...request, socket: { remoteAddress: '192.0.2.1' } },
    { ...request, headers: {} },
    { ...request, headers: { ...request.headers, 'x-forwarded-for': '' } },
    { ...request, headers: { ...request.headers, 'x-noevia-client-ip': '' } },
  ]) {
    assert.equal(await bridge(untrusted, {}), true);
    assert.equal(sent.pop().status, 404);
  }
  assert.equal(polls, 0);
  const facts = async (value) => {
    body = value;
    assert.equal(await bridge(request, {}), true);
    return sent.pop();
  };
  assert.deepEqual(await facts(body), { status: 200, body: { kind: 'listing', rows: [
    { fields: { job_id: 'j' }, infinite: ['percent'] }, null, { fields: {} },
  ] } });
  assert.equal(polls, 1);
  // The old route's choice, exactly: an array body, else jobs || downloads || [].
  assert.deepEqual((await facts([{ id: 'direct' }])).body, { kind: 'listing', rows: [{ fields: { id: 'direct' } }] });
  assert.deepEqual((await facts({ jobs: 0, downloads: [{ id: 'fallback' }] })).body,
    { kind: 'listing', rows: [{ fields: { id: 'fallback' } }] });
  assert.deepEqual((await facts({ jobs: [], downloads: true })).body, { kind: 'listing', rows: [] });
  for (const empty of [null, 'text', 7, {}]) assert.deepEqual((await facts(empty)).body, { kind: 'listing', rows: [] });
  for (const unmappable of [{ jobs: true }, { jobs: 'x' }, { downloads: { 0: {} } }]) {
    assert.deepEqual((await facts(unmappable)).body, { kind: 'fault' });
  }
  // An unchosen alternative is never expanded, however large; a chosen one is never capped.
  const huge = 'x'.repeat(17 * 1024 * 1024);
  assert.deepEqual((await facts({ jobs: [{ id: 'small' }], downloads: [{ id: huge }] })).body,
    { kind: 'listing', rows: [{ fields: { id: 'small' } }] });
  const chosen = (await facts({ jobs: [{ id: huge, model: 'm' }] })).body;
  assert.equal(chosen.kind, 'listing');
  assert.equal(chosen.rows[0].fields.id, huge);
  assert.equal(chosen.rows[0].fields.model, 'm');
  // The old public expression never touches the ignored fallback, even when
  // JSON.parse accepts nesting that JSON.stringify cannot traverse.
  const deep = JSON.parse('['.repeat(10000) + '0' + ']'.repeat(10000));
  const ignoredBody = { jobs: [{ id: 'small', job_id: deep, model_name: 'm', model: deep, status: 'done', state: deep, percent: 25, progress: deep }] };
  const ignored = await facts(ignoredBody);
  assert.deepEqual(ignored.body, { kind: 'listing', rows: [{ fields: { id: 'small', model_name: 'm', status: 'done', percent: 25 } }] });
  assert.doesNotThrow(() => JSON.stringify(ignored.body));
  const legacy = fixture({ manager: { downloads: async () => ({ ok: true, body: ignoredBody }) } });
  await legacy.call('HEAD', '/api/models/downloads');
  assert.equal(JSON.stringify(legacy.sent.pop().body),
    '[{"id":"small","model":"m","progress":0.25,"status":"done"}]');
  const unicode = String.fromCodePoint(0x10f800, 0x10ffff);
  assert.equal((await facts([{ id: unicode }])).body.rows[0].fields.id, unicode);
  const selectedDeep = JSON.parse('['.repeat(200) + '0' + ']'.repeat(200));
  assert.equal((await facts([{ id: selectedDeep }])).body.rows[0].fields.id, selectedDeep);
  const selectedBody = [{ id: unicode, model: selectedDeep }];
  const legacySelected = fixture({ manager: { downloads: async () => ({ ok: true, body: selectedBody }) } });
  await legacySelected.call('HEAD', '/api/models/downloads');
  assert.equal(JSON.stringify(legacySelected.sent.pop().body),
    JSON.stringify([{ id: unicode, model: selectedDeep, progress: null, status: '' }]));
  assert.equal(JSON.stringify((await facts(selectedBody)).body.rows[0].fields),
    JSON.stringify({ id: unicode, model: selectedDeep }));
  const polled = polls;
  manager.downloads = async () => { polls++; return { ok: false, status: 500 }; };
  assert.deepEqual((await facts(null)).body, { kind: 'failed' });
  manager.downloads = async () => { polls++; throw Error('Invalid router download listing'); };
  assert.deepEqual((await facts(null)).body, { kind: 'fault' });
  assert.equal(polls, polled + 2, 'one engine poll per facts call');
  manager.enabled = false;
  assert.deepEqual((await facts(null)).body, { kind: 'disabled' });
  assert.equal(polls, polled + 2);
});
