'use strict';
// #1765: an administrator can put the decision service back on the deployment's URL (DELETE, or PUT
// {reset:true}), audited, admin only. #1795: the Embedding row and the embedding model's card read the
// same loaded state, which follows the managed embedding service's own report. #1796: the Decision row
// names the model decisions are really sent to (decision-settings + COWORK_DECISION_MODEL) and a
// Sensitivity row names the sensitivity check's, never a stale installed preset marked as Laya.
// Synthetic fakes only: no model server, no decision service, no model runs.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createDecisionSettings, describeDecision } = require('../../server/decision-settings.cjs');
const { createFeatureRoutes } = require('../../server/routes/features.cjs');
const { createModelRoutes } = require('../../server/routes/models.cjs');
const { modelAssignments } = require('../../server/model-assignments.cjs');
const { createModelService } = require('../../server/models.cjs');
const embeddingService = require('../../server/embedding-service.cjs');

const KEV_ENV = { COWORK_DECISION_URL: 'http://kev:11435', COWORK_DECISION_MODEL: 'kev-0.8b', COWORK_SENSITIVITY_DECISION_URL: 'http://laya:8040' };

function decisionFixture(env = KEV_ENV) {
  const map = new Map(), audits = [];
  const store = { get: (k) => map.get(k), set: (k, v) => map.set(k, v), delete: (k) => map.delete(k) };
  const settings = createDecisionSettings({ store, env, fetchImpl: async () => Response.json({ ready: true }), audit: (action, actor, detail) => audits.push([action, actor, detail]) });
  // The feature registry is the Rust front's; these routes are the decision-settings leaf that stays Node's.
  const route = createFeatureRoutes({ decisionSettings: settings, json: (res, status, body) => Object.assign(res, { status, body }), readJson: async (req) => req.body });
  const call = async (method, body, role = 'admin', path = '/api/admin/decision-settings') => { const res = {}; await route({ method, body }, res, { path, authn: { user: { id: role, role } } }); return res; };
  return { map, audits, settings, call, store };
}

// ── #1765 ───────────────────────────────────────────────────────────────────────────────────────

test('#1765 DELETE forgets the saved URL: the deployment URL, its model and source apply again, audited', async () => {
  const f = decisionFixture();
  assert.equal((await f.call('PUT', { url: 'http://192.168.1.20:8040', timeoutMs: 900 })).body.source, 'admin');
  assert.equal(f.settings.backend().model, 'laya', 'a URL saved in Settings gets the Laya profile');
  const res = await f.call('DELETE');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { url: 'http://kev:11435', timeoutMs: 1500, source: 'deployment' });
  assert.equal(f.map.has('decision:configuration'), false, 'the stored key is removed, not overwritten');
  assert.equal(f.settings.backend().model, 'kev-0.8b', 'decisions go to the deployment model again');
  assert.deepEqual(f.audits.at(-1), ['decision.reset', 'admin', { hadSaved: true }]);
  // A restart reads no saved value either.
  assert.equal(createDecisionSettings({ store: f.store, env: KEV_ENV }).get().source, 'deployment');
});

test('#1765 PUT {reset:true} is the same reset; a reset with nothing saved still answers and is audited', async () => {
  const f = decisionFixture();
  const idle = await f.call('PUT', { reset: true });
  assert.equal(idle.status, 200);
  assert.equal(idle.body.source, 'deployment');
  assert.deepEqual(f.audits.at(-1), ['decision.reset', 'admin', { hadSaved: false }]);
  await f.call('PUT', { url: 'http://192.168.1.20:8040', timeoutMs: 700 });
  const res = await f.call('PUT', { reset: true });
  assert.deepEqual([res.status, res.body.url, res.body.source], [200, 'http://kev:11435', 'deployment']);
  // reset must be exactly true: anything else is an ordinary (invalid) save.
  const bad = await f.call('PUT', { reset: 'yes' });
  assert.equal(bad.status, 400);
  assert.equal(f.settings.get().source, 'deployment');
});

test('#1765 members cannot reset; the test path refuses DELETE; a store without delete still resets', async () => {
  const f = decisionFixture();
  await f.call('PUT', { url: 'http://192.168.1.20:8040', timeoutMs: 700 });
  assert.equal((await f.call('DELETE', undefined, 'member')).status, 403);
  assert.equal((await f.call('PUT', { reset: true }, 'member')).status, 403);
  assert.equal(f.settings.get().source, 'admin', 'nothing changed');
  assert.equal((await f.call('DELETE', undefined, 'admin', '/api/admin/decision-settings/test')).status, 405);
  const map = new Map([['decision:configuration', JSON.stringify({ url: 'http://192.168.1.20:8040', timeoutMs: 700 })]]);
  const legacy = createDecisionSettings({ store: { get: (k) => map.get(k), set: (k, v) => map.set(k, v) }, env: KEV_ENV });
  assert.equal(legacy.reset('admin').source, 'deployment');
  assert.equal(createDecisionSettings({ store: { get: (k) => map.get(k), set() {} }, env: KEV_ENV }).get().source, 'deployment');
});

test('#1765 the settings store deletes the row', () => {
  const { settingsStore } = require('../../server/features.cjs');
  const ran = [];
  const db = { prepare: (sql) => ({ run: (...a) => ran.push([sql, ...a]), get: () => undefined }) };
  settingsStore(db).delete('decision:configuration');
  assert.deepEqual(ran, [['DELETE FROM settings WHERE key=?', 'decision:configuration']]);
});

// ── #1796 ───────────────────────────────────────────────────────────────────────────────────────

test('#1796 the Decision row is Kev from the deployment, Sensitivity is Laya; a stale Laya preset is not used', () => {
  const installed = [{ name: 'laya_multilingual_f16', labels: [], system: true, servedElsewhere: true }];
  const a = modelAssignments({ installed, env: KEV_ENV, admin: true, isSystem: () => true });
  const by = Object.fromEntries(a.services.map((s) => [s.id, s]));
  // #1666: admins also get the choosable decision model ids and the deployment's own.
  assert.deepEqual(by.decision, { id: 'decision', model: 'kev-0.8b', state: 'active', canChange: false, source: 'deployment', models: ['laya', 'kev-0.8b'], deploymentModel: 'kev-0.8b' });
  assert.deepEqual(by.sensitivity, { id: 'sensitivity', model: 'laya', state: 'active', canChange: false, shared: false });
  assert.ok(!JSON.stringify(a).includes('laya_multilingual_f16'), 'the stale preset name is gone from the rows');
  assert.ok(!JSON.stringify(a).includes('kev:11435') && !JSON.stringify(a).includes('laya:8040'), 'no address is sent');
  const member = modelAssignments({ installed, env: KEV_ENV, admin: false });
  assert.equal('source' in member.services.find((s) => s.id === 'decision'), false, 'members do not see where it is set');
  assert.equal('models' in member.services.find((s) => s.id === 'decision'), false, 'members get no choices');
});

test('#1796 describeDecision: shared sensitivity, a URL saved in Settings, nothing set up, an unusable sensitivity URL', () => {
  const shared = describeDecision({ COWORK_DECISION_URL: 'http://kev:11435', COWORK_DECISION_MODEL: 'kev-0.8b' });
  assert.deepEqual(shared.sensitivity, { model: 'kev-0.8b', state: 'active', shared: true });
  const saved = describeDecision(KEV_ENV, { url: 'http://192.168.1.20:8040', source: 'admin' });
  assert.deepEqual(saved.decision, { model: 'laya', state: 'active', source: 'admin' }, 'another URL is sent the Laya profile, as backend() does');
  assert.deepEqual(describeDecision({}).decision, { model: null, state: 'off', source: 'deployment' });
  assert.equal(describeDecision({}).sensitivity.state, 'off');
  const badSens = describeDecision({ ...KEV_ENV, COWORK_SENSITIVITY_DECISION_URL: 'http://93.184.216.34' });
  assert.deepEqual(badSens.sensitivity, { model: null, state: 'off', shared: false }, 'never falls back to the shared service');
  // The route's settings object and the pure helper agree.
  const f = decisionFixture();
  assert.deepEqual(f.settings.describe(), describeDecision(KEV_ENV));
});

test('#1796 GET /api/models/assignments takes the decision rows from the decision settings', async () => {
  const f = decisionFixture();
  f.settings.save({ url: 'http://192.168.1.20:8040', timeoutMs: 900 }, 'admin');
  const sent = [];
  const handle = createModelRoutes({
    servedEmbeddingModels: async () => [], json: (res, status, body) => sent.push({ status, body }),
    readBody: async () => '', readJson: async () => ({}), fetchJson: async () => ({ ok: false, status: 404, body: {} }),
    env: KEV_ENV, modelManager: { enabled: true, kind: 'other', capabilities: {} },
    getProvider: () => ({}), providerHeaders: () => ({}), DEFAULT_PROVIDER_ID: 'default', createVisionProbe: () => async () => ({}),
    missingRoles: () => null, currentWorkspace: () => ({ userId: 'u1' }),
    service: { modelsInstalled: async () => [{ name: 'laya_multilingual_f16', labels: [], system: true }] },
    decisionSettings: f.settings,
  });
  const req = Readable.from([]); req.method = 'GET';
  await handle(req, { setHeader() {} }, { path: '/api/models/assignments', authn: { user: { id: 'u1', role: 'admin' } }, url: new URL('http://localhost/api/models/assignments') });
  const by = Object.fromEntries(sent.pop().body.services.map((s) => [s.id, s]));
  assert.deepEqual([by.decision.model, by.decision.source], ['laya', 'admin']);
  f.settings.reset('admin');
  await handle(Object.assign(Readable.from([]), { method: 'GET' }), { setHeader() {} }, { path: '/api/models/assignments', authn: { user: { id: 'u1', role: 'admin' } }, url: new URL('http://localhost/api/models/assignments') });
  const after = Object.fromEntries(sent.pop().body.services.map((s) => [s.id, s]));
  assert.deepEqual([after.decision.model, after.decision.source], ['kev-0.8b', 'deployment']);
});

// ── #1795 ───────────────────────────────────────────────────────────────────────────────────────

function modelService({ env, models, backends = [] }) {
  const modelManager = {
    enabled: true, capabilities: {}, requireEnabled() {},
    listModels: async () => ({ ok: true, status: 200, body: { data: models } }),
    health: async () => ({ ok: true, body: { all_models_loaded: [] } }),
  };
  const fetchJson = async (url) => (url.endsWith('/api/v1/backends') ? { ok: true, status: 200, body: { backends } } : { ok: true, status: 200, body: { models: [] } });
  return createModelService({ fetchJson, env, modelManager, currentWorkspace: () => ({ saveAutoRoles() {} }), listWorkspaces: () => [] });
}

async function managedService(body, clock = { t: 0 }) {
  const svc = embeddingService.createEmbeddingService({
    env: { MODEL_LOADER_URL: 'http://loader.invalid', EMBEDDING_SERVICE_URL: 'http://embed:8080' },
    fetchJson: async () => ({ ok: true, status: 200, body: { managed: true, enabled: true, ...body } }), now: () => clock.t, log: () => {},
  });
  embeddingService.install(svc);
  await svc.refresh();
  return { svc, clock };
}
test.afterEach(() => embeddingService.install(null));

const EMBED = 'embeddinggemma-2-Q8_0';
const EMBED_ENV = { EMBEDDING_MODEL: EMBED, MODEL_LOADER_URL: 'http://loader.invalid' };
const embedRows = () => [{ id: EMBED, labels: ['embedding'], status: { value: 'unloaded' } }, { id: 'chat-7b', status: { value: 'unloaded' } }];

test('#1795 the managed embedding service reports its model loaded: the card is Loaded and the row Running', async () => {
  // The backend probe does not list the managed container (the live case); the service says it is loaded.
  await managedService({ models: [{ model: EMBED, file: `e/${EMBED}.gguf` }], running: { reachable: true, loaded: [EMBED], listed: [EMBED] } });
  const installed = await modelService({ env: EMBED_ENV, models: embedRows() }).modelsInstalled();
  const card = installed.find((m) => m.name === EMBED);
  assert.deepEqual([card.loaded, card.status], [true, 'loaded']);
  assert.equal(installed.find((m) => m.name === 'chat-7b').loaded, false, 'only the service model follows the service');
  const row = modelAssignments({ installed, env: EMBED_ENV, admin: true }).services[0];
  assert.deepEqual([row.model, row.state], [EMBED, 'active']);
});

test('#1795 an embedding model that is really not loaded reads Unloaded in the row and on the card', async () => {
  await managedService({ models: [{ model: EMBED, file: `e/${EMBED}.gguf` }], running: { reachable: true, loaded: [], listed: [EMBED] } });
  const installed = await modelService({ env: EMBED_ENV, models: embedRows() }).modelsInstalled();
  const card = installed.find((m) => m.name === EMBED);
  assert.deepEqual([card.loaded, card.status], [false, 'unloaded']);
  const row = modelAssignments({ installed, env: EMBED_ENV, admin: true }).services[0];
  assert.equal(row.state, 'unloaded', 'not "Running" over an "Unloaded" card');
});

test('#1795 a stale service report adds nothing; the backend probe still counts; no list keeps the row as before', async () => {
  const { clock } = await managedService({ models: [{ model: EMBED, file: `e/${EMBED}.gguf` }], running: { reachable: true, loaded: [EMBED] } });
  clock.t = 60000;
  const stale = await modelService({ env: EMBED_ENV, models: embedRows() }).modelsInstalled();
  assert.equal(stale.find((m) => m.name === EMBED).loaded, false);
  embeddingService.install(null);
  const probed = await modelService({ env: EMBED_ENV, models: embedRows(), backends: [{ name: 'cowork-embed-1', status: 'running', loaded_model: EMBED }] }).modelsInstalled();
  assert.equal(probed.find((m) => m.name === EMBED).loaded, true);
  // A sidecar model with no file here (served elsewhere) is not called unloaded; an unknown list keeps "active".
  const elsewhere = modelAssignments({ installed: [{ name: EMBED, labels: ['embeddings'], loaded: false, servedElsewhere: true }], env: EMBED_ENV }).services[0];
  assert.equal(elsewhere.state, 'active');
  assert.equal(modelAssignments({ installed: null, env: EMBED_ENV }).services[0].state, 'active');
});
