'use strict';
// #1758: llama.cpp (router mode, --sleep-idle-seconds) reports an idle model as `sleeping`. It is
// running (a request wakes it; POST /models/load answers 400 "already running"), but its weights
// are freed, so it does not hold memory for the budget or the one-chat-model eviction.
// Synthetic router fixtures only.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createModelManager } = require('./model-manager.cjs');
const { resolveRuntimeLimit } = require('./chat-context.cjs');
const { createModelService } = require('./models.cjs');

// A router whose rows are { id: status }. `loadReply` answers POST /models/load.
function router(states, { loadReply } = {}) {
  const calls = [];
  const fetchJson = async (url, options = {}) => {
    const u = new URL(url), method = String(options.method || 'GET').toUpperCase();
    const body = options.body ? JSON.parse(options.body) : {};
    calls.push(`${method} ${u.pathname}${body.model ? ' ' + body.model : u.searchParams.get('model') ? ' ' + u.searchParams.get('model') : ''}`);
    if (u.pathname === '/models' && method === 'GET') return { ok: true, status: 200, body: { data: Object.entries(states).map(([id, value]) => ({ id, status: { value } })) } };
    if (u.pathname === '/props') return { ok: true, status: 200, body: { default_generation_settings: { n_ctx: 16384 }, total_slots: 1 } };
    if (u.pathname === '/models/load') return loadReply ? loadReply(body.model) : (states[body.model] = 'loaded', { ok: true, status: 200, body: { success: true } });
    if (u.pathname === '/models/unload') { states[body.model] = 'unloaded'; return { ok: true, status: 200, body: { success: true } }; }
    return { ok: true, status: 200, body: {} };
  };
  const manager = createModelManager({ kind: 'llamacpp', baseUrl: 'http://synthetic-router/v1', fetchJson, fetchStream: async () => ({ ok: false }) });
  return { manager, calls, states };
}
const loads = (calls) => calls.filter((c) => c.startsWith('POST /models/load'));

test('#1758 health counts a sleeping model as loaded (and marks it sleeping)', async () => {
  const { manager } = router({ 'syn-chat': 'sleeping', 'syn-cold': 'unloaded' });
  const health = await manager.health();
  assert.deepEqual(health.body.all_models_loaded.map((m) => [m.model_name, m.loaded, m.sleeping === true]), [['syn-chat', true, true]]);
  assert.equal(health.body.all_models_loaded[0].recipe_options.ctx_size, 16384);
  const listed = await manager.listModels();
  const row = listed.body.data.find((m) => m.id === 'syn-chat');
  assert.equal(row.loaded, true);
  assert.equal(row.status.value, 'sleeping', 'the status reaches the Models page unchanged');
});

test('#1758 chat with a sleeping selected model never calls /models/load and proceeds', async () => {
  const { manager, calls } = router({ 'syn-chat': 'sleeping' });
  const statuses = [];
  const result = await resolveRuntimeLimit({ manager, model: 'syn-chat', onStatus: (s) => statuses.push(s) });
  assert.equal(result.limit, 16384);
  assert.deepEqual(loads(calls), []);
  assert.deepEqual(statuses, [], 'no "Loading the selected model" status for a sleeping model');
});

test('#1758 manager.load of a sleeping model succeeds without POST /models/load', async () => {
  const { manager, calls } = router({ 'syn-chat': 'sleeping' }, { loadReply: () => ({ ok: false, status: 400, body: { error: { message: 'model is already running' } } }) });
  const r = await manager.load('syn-chat');
  assert.equal(r.ok, true);
  assert.deepEqual(loads(calls), []);
});

test('#1758 load() skips the POST for a sleeping target while a different model is loaded', async () => {
  const { manager, calls, states } = router({ 'syn-other': 'loaded', 'syn-chat': 'sleeping' }, { loadReply: () => ({ ok: false, status: 400, body: { error: 'model is already running' } }) });
  const r = await manager.load('syn-chat');
  assert.equal(r.ok, true);
  assert.deepEqual(loads(calls), [], 'no POST /models/load for the sleeping target');
  assert.deepEqual(calls.filter((c) => c.startsWith('POST /models/unload')), ['POST /models/unload syn-other'], 'the other chat model still makes room');
  assert.equal(states['syn-chat'], 'sleeping');
});

test('#1758 a 400 "already running" from /models/load is success, logged once', async (t) => {
  // The listing says unloaded, but the model woke (another client) before the load arrived.
  const states = { 'syn-chat': 'unloaded' };
  const { manager, calls } = router(states, { loadReply: () => { states['syn-chat'] = 'sleeping'; return { ok: false, status: 400, body: { error: { code: 400, message: 'model is already running', type: 'invalid_request_error' } } }; } });
  const logs = [];
  t.mock.method(console, 'log', (m) => logs.push(String(m)));
  assert.equal((await manager.load('syn-chat')).ok, true);
  states['syn-chat'] = 'unloaded';
  assert.equal((await manager.load('syn-chat')).ok, true);
  assert.equal(loads(calls).length, 2);
  assert.equal(logs.filter((m) => m.includes('load-already-running')).length, 1);
  // Any other 400 still fails.
  const other = router({ 'syn-chat': 'unloaded' }, { loadReply: () => ({ ok: false, status: 400, body: { error: 'model not found' } }) });
  assert.equal((await other.manager.load('syn-chat')).ok, false);
});

test('#1758 ensureModelLoaded with a sleeping model succeeds without a load', async () => {
  const { manager, calls } = router({ 'syn-chat': 'sleeping' }, { loadReply: () => ({ ok: false, status: 400, body: { error: 'model is already running' } }) });
  const workspace = { autoRoles: null, saveAutoRoles() {} };
  const service = createModelService({ fetchJson: async () => ({ ok: false }), env: {}, modelManager: manager, currentWorkspace: () => workspace, listWorkspaces: () => [workspace] });
  await service.ensureModelLoaded('syn-chat');
  assert.deepEqual(loads(calls), []);
  const installed = await service.modelsInstalled();
  assert.equal(installed.find((m) => m.name === 'syn-chat').status, 'sleeping');
});

test('#1758 the budget and eviction treat a sleeping model as not resident', async () => {
  // A sleeping chat model does not occupy the one-model slot: loading another neither unloads it
  // nor is refused because of it (the router swaps it under --models-max 1).
  const { manager, calls } = router({ 'syn-sleeper': 'sleeping', 'syn-next': 'unloaded' });
  const r = await manager.load('syn-next');
  assert.equal(r.ok, true);
  assert.deepEqual(calls.filter((c) => c.startsWith('POST /models/unload')), []);
  await manager.makeRoomFor('syn-next', []);
  assert.deepEqual(calls.filter((c) => c.startsWith('POST /models/unload')), []);
  // The memory watchdog's resident list leaves it out, and the estimates do not show it loaded.
  const { loadedFromListing } = require('./inference-budget-watch.cjs');
  assert.deepEqual(loadedFromListing({ ok: true, body: { data: [{ id: 'syn-sleeper', status: { value: 'sleeping' } }, { id: 'syn-next', status: { value: 'loaded' } }] } }), ['syn-next']);
  const est = await manager.inferenceEstimates();
  const row = est.body.models.find((m) => m.model === 'syn-sleeper');
  assert.equal(row.loaded, false);
  assert.equal(row.sleeping, true);
});

test('#1758 the embedding fallback on the chat router counts a sleeping embedding model as served', async (t) => {
  const rag = require('./rag.cjs');
  // #1760: servedModels uses rag.cjs's own connect-time-checked fetch, so the stub goes in through its seam.
  const seen = [];
  const previous = rag._test.setRagFetch(async (url) => { seen.push(String(url)); return new Response(JSON.stringify({ data: [
    { id: 'syn-embed', status: { value: 'sleeping' } }, { id: 'syn-cold', status: { value: 'unloaded' } }, { id: 'syn-up', status: { value: 'loaded' } },
  ] }), { status: 200, headers: { 'content-type': 'application/json' } }); });
  t.after(() => rag._test.setRagFetch(previous));
  const ids = await rag.servedModels({ baseUrl: 'http://synthetic-embed' });
  assert.deepEqual(seen, ['http://synthetic-embed/v1/models']);
  assert.deepEqual(ids.sort(), ['syn-embed', 'syn-up']);
});
