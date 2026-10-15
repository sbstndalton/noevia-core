'use strict';
// #1665: the reranker's on/off and model as an admin runtime setting over the deployment's RERANK_* environment
// (saved like the decision settings, audited, resettable, admin-only for reading and writing, no address sent).
// #1666: the decision model chosen next to the decision URL (kev-0.8b, laya or automatic), stored with the decision
// settings; automatic keeps the deployment's COWORK_DECISION_MODEL rule. #1667: the Creative role is saved,
// validated and cleared like the other optional roles.
// Synthetic fakes only: no reranker, no decision service, no model runs.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createRerankSettings } = require('../../server/rerank-settings.cjs');
const { rerankTarget } = require('../../server/rerank-target.cjs');
const { createDecisionSettings, describeDecision } = require('../../server/decision-settings.cjs');
const { createFeatures } = require('../../server/features.cjs');
const { createFeatureRoutes } = require('../../server/routes/features.cjs');
const { createModelRoutes } = require('../../server/routes/models.cjs');
const { modelAssignments } = require('../../server/model-assignments.cjs');
const { createModelService } = require('../../server/models.cjs');

// The live shape (#1665 core#121): the TEI gte sidecar, on.
const TEI_ENV = { NOEVIA_FEATURE_RAG_RERANK: 'true', RERANK_BACKEND: 'tei', RERANK_BASE_URL: 'http://rerank:8080', RERANK_MODEL: 'gte-multilingual-reranker-base' };
const INSTALLED = [
  { name: 'synthetic-chat', labels: [] },
  { name: 'synthetic-reranker-q8', labels: ['reranking'] },
  { name: 'synthetic-gone-reranker', labels: ['reranking'], missingFile: true },
];
const memStore = () => { const map = new Map(); return { map, get: (k) => map.get(k), set: (k, v) => map.set(k, v), delete: (k) => map.delete(k) }; };
const noAddress = (value) => assert.doesNotMatch(JSON.stringify(value), /https?:\/\/|rerank:8080|10\.0\.0\./, 'no address reaches the browser');

function rerankFixture(env = TEI_ENV) {
  const store = memStore(), audits = [];
  let changes = 0;
  const settings = createRerankSettings({ store, env, audit: (a, actor, d) => audits.push([a, actor, d]), onChange: () => { changes += 1; } });
  return { store, audits, settings, changes: () => changes };
}

// ── #1665 ───────────────────────────────────────────────────────────────────────────────────────

test('#1665 nothing saved: the deployment environment applies unchanged, and the reply names no address', () => {
  const f = rerankFixture();
  assert.equal(f.settings.effectiveEnv(), TEI_ENV, 'the very same environment object: nothing changes on deploy');
  const got = f.settings.get(INSTALLED);
  assert.deepEqual(got, { enabled: true, choice: 'tei', source: 'deployment', options: [{ id: 'tei', backend: 'tei', model: 'gte-multilingual-reranker-base' }] });
  noAddress(got);
});

test('#1665 turning reranking off and on again is saved, applied at once, audited and survives a restart', () => {
  const f = rerankFixture();
  const off = f.settings.save({ enabled: false }, 'admin-1', INSTALLED);
  assert.deepEqual([off.enabled, off.choice, off.source], [false, 'tei', 'admin']);
  assert.equal(rerankTarget(f.settings.effectiveEnv()).enabled, false, 'retrieval stops reranking');
  assert.deepEqual(f.audits.at(-1), ['rerank.configure', 'admin-1', { enabled: false, backend: 'tei', model: 'gte-multilingual-reranker-base' }]);
  assert.equal(f.changes(), 1, 'retrieval is reconfigured');
  const restarted = createRerankSettings({ store: f.store, env: TEI_ENV });
  assert.equal(restarted.get(INSTALLED).enabled, false);
  f.settings.save({ enabled: true, choice: 'tei' }, 'admin-1', INSTALLED);
  const target = rerankTarget(f.settings.effectiveEnv());
  assert.deepEqual([target.enabled, target.backend, target.baseUrl, target.model], [true, 'tei', 'http://rerank:8080', 'gte-multilingual-reranker-base']);
});

test('#1665 a llama.cpp reranker preset is offered only with a llama.cpp rerank address, and switching to it maps the address server-side', () => {
  assert.deepEqual(rerankFixture().settings.options(INSTALLED).map((o) => o.id), ['tei'], 'no llama.cpp address: no presets offered');
  const env = { ...TEI_ENV, RERANK_LLAMACPP_BASE_URL: 'http://10.0.0.7:8091' };
  const f = rerankFixture(env);
  assert.deepEqual(f.settings.options(INSTALLED).map((o) => o.id), ['tei', 'llamacpp:synthetic-reranker-q8'], 'a preset whose file is gone is never offered');
  const saved = f.settings.save({ enabled: true, choice: 'llamacpp:synthetic-reranker-q8' }, 'admin-1', INSTALLED);
  noAddress(saved);
  const target = rerankTarget(f.settings.effectiveEnv());
  assert.deepEqual([target.enabled, target.backend, target.baseUrl, target.model], [true, 'llamacpp', 'http://10.0.0.7:8091', 'synthetic-reranker-q8']);
  assert.deepEqual(f.audits.at(-1)[2], { enabled: true, backend: 'llamacpp', model: 'synthetic-reranker-q8' });
  // A llama.cpp deployment (RERANK_BACKEND=llamacpp) offers its own installed presets at its RERANK_BASE_URL.
  const llama = rerankFixture({ NOEVIA_FEATURE_RAG_RERANK: 'false', RERANK_BACKEND: 'llamacpp', RERANK_BASE_URL: 'http://10.0.0.8:8090', RERANK_MODEL: 'synthetic-reranker-q8' });
  assert.deepEqual(llama.settings.get(INSTALLED), { enabled: false, choice: 'llamacpp:synthetic-reranker-q8', source: 'deployment', options: [{ id: 'llamacpp:synthetic-reranker-q8', backend: 'llamacpp', model: 'synthetic-reranker-q8' }] });
});

test('#1665 the shared-engine guard still applies to a saved choice (#697)', () => {
  const env = { ...TEI_ENV, RERANK_LLAMACPP_BASE_URL: 'http://engine:8080', INFERENCE_BASE_URL: 'http://engine:8080' };
  const f = rerankFixture(env);
  f.settings.save({ enabled: true, choice: 'llamacpp:synthetic-reranker-q8' }, 'admin-1', INSTALLED);
  const target = rerankTarget(f.settings.effectiveEnv());
  assert.equal(target.enabled, false);
  assert.equal(target.shared, true);
});

test('#1665 refusals: unknown reranker, on without a reranker, an unreadable catalogue, a malformed body; nothing is saved', () => {
  const f = rerankFixture({ ...TEI_ENV, RERANK_LLAMACPP_BASE_URL: 'http://10.0.0.7:8091' });
  const refuse = (body, installed, id, status = 400) => assert.throws(() => f.settings.save(body, 'admin-1', installed), (e) => e.status === status && e.messageId === id);
  refuse({ enabled: true, choice: 'llamacpp:synthetic-gone-reranker' }, INSTALLED, 'unknownReranker');
  refuse({ enabled: true, choice: 'llamacpp:not-installed' }, INSTALLED, 'unknownReranker');
  refuse({ enabled: true, choice: 'llamacpp:synthetic-reranker-q8' }, null, 'catalogueUnavailable', 503);
  refuse({ enabled: true, choice: null }, INSTALLED, 'noReranker');
  refuse({ enabled: 'yes' }, INSTALLED, 'invalidInput');
  refuse(null, INSTALLED, 'invalidInput');
  assert.equal(f.store.map.size, 0);
  assert.equal(f.audits.length, 0);
  // Off with no reranker at all is allowed (nothing to rerank with is a valid "off").
  assert.equal(f.settings.save({ enabled: false, choice: null }, 'admin-1', INSTALLED).enabled, false);
});

test('#1665 a saved choice whose address left the deployment turns reranking off instead of guessing', () => {
  const store = memStore();
  createRerankSettings({ store, env: { ...TEI_ENV, RERANK_LLAMACPP_BASE_URL: 'http://10.0.0.7:8091' } }).save({ enabled: true, choice: 'llamacpp:synthetic-reranker-q8' }, 'a', INSTALLED);
  const later = createRerankSettings({ store, env: TEI_ENV });
  assert.equal(rerankTarget(later.effectiveEnv()).enabled, false);
});

test('#1665 reset ("use deployment default") forgets the saved switch, audited even with nothing saved', () => {
  const f = rerankFixture();
  assert.equal(f.settings.reset('admin-1', INSTALLED).source, 'deployment');
  assert.deepEqual(f.audits.at(-1), ['rerank.reset', 'admin-1', { hadSaved: false }]);
  f.settings.save({ enabled: false }, 'admin-1', INSTALLED);
  const back = f.settings.reset('admin-1', INSTALLED);
  assert.deepEqual([back.enabled, back.source], [true, 'deployment']);
  assert.equal(f.store.map.has('rerank:configuration'), false);
  assert.deepEqual(f.audits.at(-1), ['rerank.reset', 'admin-1', { hadSaved: true }]);
  assert.equal(f.settings.effectiveEnv(), TEI_ENV);
});

function routesFixture({ env = TEI_ENV, rerankSettings = rerankFixture(env).settings, decisionSettings = null, installed = async () => INSTALLED, roles = { current: null } } = {}) {
  const sent = [];
  const handle = createModelRoutes({
    servedEmbeddingModels: async () => [], json: (res, status, body) => sent.push({ status, body }),
    readBody: async (req) => req.raw ?? JSON.stringify(req.body ?? {}), readJson: async (req) => { if (req.raw !== undefined) return JSON.parse(req.raw); return req.body; },
    fetchJson: async () => ({ ok: false, status: 404, body: {} }),
    env, modelManager: { enabled: true, kind: 'other', capabilities: {} },
    getProvider: () => ({}), providerHeaders: () => ({}), DEFAULT_PROVIDER_ID: 'default', createVisionProbe: () => async () => ({}),
    reportedTokenRate: () => null, missingRoles: () => [], currentWorkspace: () => ({ userId: 'u1' }),
    service: { modelScanCache: { clear() {} }, modelsInstalled: installed, servedCatalogue: installed, autoRoles: () => roles.current, setAutoRoles: (next) => { roles.current = next; }, ensureRolesLoaded() {} },
    decisionSettings, rerankSettings,
  });
  const call = async (method, path, { body, raw, role = 'admin' } = {}) => {
    const req = Object.assign(Readable.from([]), { method, body, raw });
    const handled = await handle(req, { setHeader() {} }, { path, authn: { user: { id: `${role}-1`, role } }, url: new URL(`http://localhost${path}`) });
    return handled === false ? null : sent.pop();
  };
  return { call, sent, roles };
}

test('#1665 /api/models/reranker is admin-only for every method, including a deep-linked GET', async () => {
  const r = routesFixture();
  for (const method of ['GET', 'PUT', 'DELETE']) {
    const res = await r.call(method, '/api/models/reranker', { role: 'member', body: { enabled: false } });
    assert.equal(res.status, 403, `member ${method}`);
  }
  const got = await r.call('GET', '/api/models/reranker');
  assert.deepEqual([got.status, got.body.enabled, got.body.choice], [200, true, 'tei']);
  noAddress(got.body);
  assert.equal((await r.call('POST', '/api/models/reranker')).status, 405);
});

test('#1665 the route saves, refuses with an error id, and resets by DELETE or {reset:true}', async () => {
  const f = rerankFixture();
  const r = routesFixture({ rerankSettings: f.settings });
  const off = await r.call('PUT', '/api/models/reranker', { body: { enabled: false } });
  assert.deepEqual([off.status, off.body.enabled, off.body.source], [200, false, 'admin']);
  assert.deepEqual(f.audits.at(-1).slice(0, 2), ['rerank.configure', 'admin-1']);
  const bad = await r.call('PUT', '/api/models/reranker', { body: { enabled: true, choice: 'llamacpp:x' } });
  assert.deepEqual([bad.status, bad.body.errorId], [400, 'unknownReranker']);
  const junk = await r.call('PUT', '/api/models/reranker', { raw: '{' });
  assert.deepEqual([junk.status, junk.body.errorId], [400, 'invalidInput']);
  const reset = await r.call('PUT', '/api/models/reranker', { body: { reset: true } });
  assert.deepEqual([reset.status, reset.body.source], [200, 'deployment']);
  await r.call('PUT', '/api/models/reranker', { body: { enabled: false } });
  const del = await r.call('DELETE', '/api/models/reranker');
  assert.deepEqual([del.status, del.body.source, del.body.enabled], [200, 'deployment', true]);
});

test('#1665 the Reranker row: admins get the switch (no address), members the read-only state', async () => {
  const f = rerankFixture();
  f.settings.save({ enabled: false }, 'admin-1', INSTALLED);
  const admin = modelAssignments({ installed: INSTALLED, env: TEI_ENV, admin: true, rerank: f.settings }).services.find((s) => s.id === 'reranker');
  assert.deepEqual(admin, { id: 'reranker', model: 'gte-multilingual-reranker-base', state: 'off', canChange: true, options: [], enabled: false, choice: 'tei', source: 'admin',
    choices: [{ id: 'tei', backend: 'tei', model: 'gte-multilingual-reranker-base' }] });
  const member = modelAssignments({ installed: INSTALLED, env: TEI_ENV, admin: false, rerank: f.settings }).services.find((s) => s.id === 'reranker');
  assert.deepEqual(member, { id: 'reranker', model: 'gte-multilingual-reranker-base', state: 'off', canChange: false });
  const r = routesFixture({ rerankSettings: f.settings });
  for (const role of ['admin', 'member']) noAddress((await r.call('GET', '/api/models/assignments', { role })).body);
});

test('#1665 retrieval follows the saved switch (rag.configureRerank / reloadRerank), fail-open path unchanged', () => {
  const rag = require('../../server/rag.cjs');
  const f = rerankFixture();
  try {
    rag.configureRerank(() => f.settings.effectiveEnv());
    assert.equal(rag._test.rerankState()?.backend, 'tei');
    f.settings.save({ enabled: false }, 'admin-1', INSTALLED);
    rag.reloadRerank();
    assert.equal(rag._test.rerankState(), null, 'off: retrieval keeps cosine ranking');
    f.settings.reset('admin-1', INSTALLED);
    rag.reloadRerank();
    assert.equal(rag._test.rerankState()?.backend, 'tei');
  } finally { rag.configureRerank(() => ({})); }
  assert.equal(rag._test.rerankState(), null);
});

// ── #1666 ───────────────────────────────────────────────────────────────────────────────────────

const KEV_ENV = { COWORK_DECISION_URL: 'http://kev:11435', COWORK_DECISION_MODEL: 'kev-0.8b', COWORK_DECISION_API_KEY: 'synthetic-key' };
function decisionFixture(env = KEV_ENV) {
  const store = memStore(), audits = [];
  const settings = createDecisionSettings({ store, env, fetchImpl: async () => Response.json({ ready: true }), audit: (a, actor, d) => audits.push([a, actor, d]) });
  const features = createFeatures({ store, env: {}, availability: {} });
  const route = createFeatureRoutes({ features, decisionSettings: settings, json: (res, status, body) => Object.assign(res, { status, body }), readJson: async (req) => req.body });
  const call = async (method, body, role = 'admin') => { const res = {}; await route({ method, body }, res, { path: '/api/admin/decision-settings', authn: { user: { id: `${role}-1`, role } } }); return res; };
  return { store, audits, settings, call };
}

test('#1666 nothing chosen: the deployment model applies, the GET reply keeps its recorded shape, admins get the choices on the row', async () => {
  const f = decisionFixture();
  const got = await f.call('GET');
  assert.deepEqual(got.body, { url: 'http://kev:11435', timeoutMs: 1500, source: 'deployment' }, 'unchanged (the HTTP contract corpus)');
  assert.deepEqual([f.settings.backend().model, f.settings.backend().wording], ['kev-0.8b', 'kev']);
  const row = modelAssignments({ installed: [], env: KEV_ENV, admin: true, decision: f.settings.describe() }).services.find((s) => s.id === 'decision');
  assert.deepEqual([row.models, row.deploymentModel], [['laya', 'kev-0.8b'], 'kev-0.8b']);
  assert.equal('models' in modelAssignments({ installed: [], env: KEV_ENV, admin: false }).services.find((s) => s.id === 'decision'), false);
});

test('#1666 choosing a model is an admin save next to the URL: requests and wording follow it, audited', async () => {
  const f = decisionFixture();
  // Laya on the deployment's own Kev URL: Laya format and wording, even though COWORK_DECISION_MODEL says Kev.
  const laya = await f.call('PUT', { url: 'http://kev:11435', timeoutMs: 1500, model: 'laya' });
  assert.deepEqual([laya.status, laya.body.model, laya.body.source], [200, 'laya', 'admin']);
  assert.deepEqual([f.settings.backend().model, f.settings.backend().wording], ['laya', 'laya']);
  assert.deepEqual(f.audits.at(-1), ['decision.configure', 'admin-1', { url: 'http://kev:11435', timeoutMs: 1500, model: 'laya' }]);
  assert.deepEqual(describeDecision(KEV_ENV, f.settings.get()).decision, { model: 'laya', state: 'active', source: 'admin', modelSource: 'admin' });
  // Kev on another URL (before #1666 that URL always got Laya), case-insensitive.
  await f.call('PUT', { url: 'http://192.168.1.20:11435', timeoutMs: 900, model: ' KEV-0.8B ' });
  assert.deepEqual([f.settings.backend().model, f.settings.backend().wording], ['kev-0.8b', 'kev']);
  assert.equal(f.settings.describe().decision.model, 'kev-0.8b');
  assert.equal(f.settings.describe().sensitivity.model, 'kev-0.8b', 'a shared sensitivity check follows the chosen model');
  // Automatic ('' or absent) goes back to the #1639 rule: another URL gets Laya, the deployment URL its model.
  await f.call('PUT', { url: 'http://192.168.1.20:11435', timeoutMs: 900, model: '' });
  assert.equal(f.settings.backend().model, 'laya');
  await f.call('PUT', { url: 'http://kev:11435', timeoutMs: 900 });
  assert.equal(f.settings.backend().model, 'kev-0.8b');
  assert.deepEqual(f.audits.at(-1)[2], { url: 'http://kev:11435', timeoutMs: 900, model: 'auto' });
});

test('#1666 an unknown model id is refused (not silently sent as Laya), and members cannot choose', async () => {
  const f = decisionFixture();
  for (const model of ['decima-small', 7, {}]) {
    const res = await f.call('PUT', { url: 'http://kev:11435', timeoutMs: 1500, model });
    assert.deepEqual([res.status, res.body.errorId], [400, 'invalidModel'], JSON.stringify(model));
  }
  const member = await f.call('PUT', { url: 'http://kev:11435', timeoutMs: 1500, model: 'laya' }, 'member');
  assert.equal(member.status, 403);
  assert.equal((await f.call('GET', undefined, 'member')).status, 403, 'a deep-linked read is refused too');
  assert.equal(f.settings.get().source, 'deployment');
  // An unknown COWORK_DECISION_MODEL still falls back to Laya wording, as before.
  const typo = decisionFixture({ COWORK_DECISION_URL: 'http://laya:8040', COWORK_DECISION_MODEL: 'kev-typo' });
  assert.equal(typo.settings.backend().wording, 'laya');
});

test('#1666 reset forgets the chosen model with the URL; a saved record from before #1666 reads as automatic', async () => {
  const f = decisionFixture();
  await f.call('PUT', { url: 'http://kev:11435', timeoutMs: 1500, model: 'laya' });
  const reset = await f.call('DELETE');
  assert.deepEqual([reset.body.model, reset.body.source], [undefined, 'deployment']);
  assert.equal(f.settings.backend().model, 'kev-0.8b');
  const store = memStore();
  store.set('decision:configuration', JSON.stringify({ url: 'http://kev:11435', timeoutMs: 1200 }));
  const old = createDecisionSettings({ store, env: KEV_ENV });
  assert.deepEqual([old.get().model, old.backend().model], [undefined, 'kev-0.8b']);
});

// ── #1667 ───────────────────────────────────────────────────────────────────────────────────────

test('#1667 PUT /api/auto-roles saves an optional Creative model, refuses a non-chat one, and an old client keeps it', async () => {
  const catalogue = async () => [{ name: 'synthetic-fast' }, { name: 'synthetic-smart' }, { name: 'synthetic-creative' }, { name: 'synthetic-reranker-q8', labels: ['reranking'] }];
  const r = routesFixture({ installed: catalogue });
  const saved = await r.call('PUT', '/api/auto-roles', { body: { fast: 'synthetic-fast', smart: 'synthetic-smart', creative: 'synthetic-creative' } });
  assert.equal(saved.status, 200);
  assert.equal(r.roles.current.creative, 'synthetic-creative');
  // A client from before #1667 sends no `creative`: the saved one stays.
  await r.call('PUT', '/api/auto-roles', { body: { fast: 'synthetic-fast', smart: 'synthetic-smart', vision: '', code: '' } });
  assert.equal(r.roles.current.creative, 'synthetic-creative');
  // An explicit '' clears it.
  await r.call('PUT', '/api/auto-roles', { body: { fast: 'synthetic-fast', smart: 'synthetic-smart', creative: '' } });
  assert.equal(r.roles.current.creative, undefined);
  const unknown = await r.call('PUT', '/api/auto-roles', { body: { fast: 'synthetic-fast', smart: 'synthetic-smart', creative: 'nope' } });
  assert.equal(unknown.status, 400);
  const nonChat = await r.call('PUT', '/api/auto-roles', { body: { fast: 'synthetic-fast', smart: 'synthetic-smart', creative: 'synthetic-reranker-q8' } });
  assert.deepEqual([nonChat.status, /creative role needs a chat model/.test(nonChat.body.error)], [400, true]);
});

test('#1667 deleting the Creative model clears only that optional role', () => {
  const ws = { userId: 'u1', autoRoles: { fast: 'f', smart: 's', creative: 'c' }, saves: 0, saveAutoRoles() { this.saves += 1; } };
  const service = createModelService({ modelManager: { enabled: false, capabilities: {} }, currentWorkspace: () => ws, listWorkspaces: () => [ws] });
  assert.deepEqual(service.clearRoleReferences('c'), ['creative']);
  assert.deepEqual(ws.autoRoles, { fast: 'f', smart: 's' });
});
