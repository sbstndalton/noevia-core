'use strict';
// #1461: the installed list is shared for a moment (service.modelsInstalled), so the page loads, Models tabs and
// the auto-router stop each paying for the same model-manager calls. A model write drops it
// (invalidateModelReads), and a decision that must see the engine now uses modelsInstalledFresh().
const test = require('node:test');
const assert = require('node:assert/strict');
const { createModelService } = require('./models.cjs');

function service(calls) {
  const modelManager = {
    enabled: true,
    requireEnabled() {},
    async listModels() { calls.list += 1; return { ok: true, body: { data: [{ id: 'chat-syn', status: { value: 'loaded' } }] } }; },
    async health() { calls.health += 1; return { ok: true, body: { all_models_loaded: [{ model_name: 'chat-syn', loaded: true }] } }; },
    async load() { calls.load += 1; return { ok: true }; },
  };
  const workspace = { autoRoles: null, saveAutoRoles() {} };
  return createModelService({ fetchJson: async () => ({ ok: false }), env: {}, modelManager, currentWorkspace: () => workspace, listWorkspaces: () => [workspace] });
}

test('the installed list is read once for repeated page reads within the TTL', async () => {
  const calls = { list: 0, health: 0, load: 0 };
  const svc = service(calls);
  const [a, b] = await Promise.all([svc.modelsInstalled(), svc.modelsInstalled()]);
  assert.equal(a, b);
  await svc.modelsInstalled();
  assert.equal(calls.list, 1, 'one model-manager list call for the page reads');
  assert.equal(calls.health, 1);
  assert.equal(a[0].name, 'chat-syn');
});

test('a model write drops the shared list, so the next read is fresh', async () => {
  const calls = { list: 0, health: 0, load: 0 };
  const svc = service(calls);
  await svc.modelsInstalled();
  svc.invalidateModelReads();
  await svc.modelsInstalled();
  assert.equal(calls.list, 2);
});

test('the fresh read always asks the engine, even while the shared list is kept', async () => {
  const calls = { list: 0, health: 0, load: 0 };
  const svc = service(calls);
  await svc.modelsInstalled();
  await svc.modelsInstalledFresh();
  await svc.modelsInstalledFresh();
  assert.equal(calls.list, 3);
});

test('loading a model through the service refreshes the shared list afterwards', async () => {
  const calls = { list: 0, health: 0, load: 0 };
  const svc = service(calls);
  await svc.modelsInstalled();
  // The loaded flag must come from the engine after a load, not from a list kept before it.
  await svc.ensureModelLoaded('chat-syn');
  assert.equal(calls.load, 0, 'the model was already loaded, so nothing is loaded again');
  await svc.modelsInstalled();
  assert.equal(calls.list, 2, 'the fresh check ran the engine list, and the shared list is read again after it');
});

test('a failed list read is not kept', async () => {
  const calls = { list: 0, health: 0, load: 0 };
  let fail = true;
  const modelManager = { enabled: true, requireEnabled() {}, async listModels() { calls.list += 1; if (fail) throw new Error('down'); return { ok: true, body: { data: [] } }; }, async health() { return { ok: true, body: { all_models_loaded: [] } }; } };
  const workspace = { autoRoles: null, saveAutoRoles() {} };
  const down = createModelService({ fetchJson: async () => ({ ok: false }), env: {}, modelManager, currentWorkspace: () => workspace, listWorkspaces: () => [workspace] });
  await assert.rejects(down.modelsInstalled(), /model list failed/);
  fail = false;
  assert.deepEqual(await down.modelsInstalled(), []);
  assert.equal(calls.list, 2);
});

test('a list built with a failed folder scan is served but not kept, so the next read retries the scan (#1088)', async () => {
  const calls = { list: 0, health: 0, load: 0 };
  let scans = 0;
  const modelManager = { enabled: true, requireEnabled() {}, async listModels() { calls.list += 1; return { ok: true, body: { data: [{ id: 'Qwen-x', source: 'preset', status: { value: 'unloaded' } }] } }; }, async health() { return { ok: true, body: { all_models_loaded: [] } }; } };
  const workspace = { autoRoles: null, saveAutoRoles() {} };
  const fetchJson = async (url) => {
    if (String(url).endsWith('/api/v1/models')) { scans += 1; return scans === 1 ? { ok: false, status: 504, body: {} } : { ok: true, status: 200, body: { models: [] } }; }
    return { ok: false };
  };
  const svc = createModelService({ fetchJson, env: { MODEL_LOADER_URL: 'http://loader' }, modelManager, currentWorkspace: () => workspace, listWorkspaces: () => [workspace] });
  await svc.modelsInstalled();
  await svc.modelsInstalled();
  assert.equal(calls.list, 2, 'the degraded list was not kept');
});
