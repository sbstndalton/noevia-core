'use strict';
// #1668: the embedding service is settings-driven (the model manager serves a set of models in
// cowork-embed, or nothing when embedding is off). Synthetic model names and stub servers only.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const embeddingService = require('../../server/embedding-service.cjs');
const embeddingConfigModule = require('../../server/embedding-config.cjs');
const { createEmbeddingConfig } = embeddingConfigModule;
const { createEmbeddingMigration } = require('../../server/embedding-migration.cjs');
const { createEmbeddingRoutes } = require('../../server/routes/embedding.cjs');
const { sidecarModelNames, isSidecarModel } = require('../../server/model-system.cjs');
const rag = require('../../server/rag.cjs');

const SVC = 'http://embed:8080';
const NOMIC = { model: 'nomic-embed-text-v1', file: 'nomic-embed-text-v1/nomic-embed-text-v1.Q8_0.gguf' };
const GEMMA = { model: 'embeddinggemma-2', file: 'embeddinggemma-2/embeddinggemma-2-Q8_0.gguf' };

function stub(handler) {
  const seen = [];
  const srv = http.createServer((req, res) => { seen.push(`${req.method} ${req.url}`); handler(req, res); });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ seen, url: `http://127.0.0.1:${srv.address().port}`, close: () => { srv.closeAllConnections?.(); srv.close(); } })));
}

/** A fake model manager: GET/PUT /api/v1/embedding-service, GET /api/v1/models. */
function fakeLoader({ models = [NOMIC], loaded = null, installed = [NOMIC, GEMMA], loadOnServe = true } = {}) {
  const state = { models: [...models], previous: [], loaded: loaded || models.map((m) => m.model), puts: [], up: true };
  const body = () => ({ managed: true, container: 'cowork-embed-1', enabled: state.models.length > 0, models: state.models, previous: state.previous,
    running: { reachable: state.models.length > 0, loaded: state.loaded, listed: state.models.map((m) => m.model) } });
  const fetchJson = async (url, init = {}) => {
    if (!state.up) throw new Error('ECONNREFUSED');
    const p = new URL(url).pathname;
    if (p === '/api/v1/embedding-service' && (init.method || 'GET') === 'GET') {
      // The model manager's warm-up releases `previous` once the router has dropped it.
      if (loadOnServe) state.previous = [];
      return { ok: true, status: 200, body: body() };
    }
    if (p === '/api/v1/embedding-service' && init.method === 'PUT') {
      const want = JSON.parse(init.body).models;
      state.puts.push(want.map((m) => m.model));
      state.previous = state.models.filter((m) => !want.some((w) => w.model === m.model));
      state.models = want;
      state.loaded = loadOnServe ? want.map((m) => m.model) : state.loaded.filter((id) => want.some((w) => w.model === id));
      if (!want.length) { state.previous = []; state.loaded = []; }
      return { ok: true, status: 202, body: body() };
    }
    if (p === '/api/v1/models') return { ok: true, status: 200, body: installed.map((m) => ({ modelId: m.model, sections: [m.model], name: m.file.split('/').pop(), file: m.file })) };
    throw new Error(`unexpected ${p}`);
  };
  return { state, fetchJson };
}

const LOADER_ENV = { MODEL_LOADER_URL: 'http://model-loader:8090', EMBEDDING_SERVICE_URL: SVC };

async function installService(loader, env = LOADER_ENV, clock = { t: 0 }) {
  const svc = embeddingService.createEmbeddingService({ env, fetchJson: loader.fetchJson, now: () => clock.t, sleep: async () => { clock.t += 2000; }, log: () => {} });
  embeddingService.install(svc);
  await svc.refresh();
  return svc;
}

test.afterEach(() => { embeddingService.install(null); embeddingConfigModule.install(null); });

// ── identity: a router lists unloaded presets too ─────────────────────────────────────────────

test('servedModels counts only loaded router entries, so an unloaded preset never passes the identity check', async () => {
  const s = await stub((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: [
      { id: 'nomic-embed-text-v1', status: { value: 'loaded' } },
      { id: 'embeddinggemma-2', status: { value: 'unloaded' } },
      { id: 'plain-single-model-server' },
    ] }));
  });
  try {
    const ids = await rag.servedModels({ baseUrl: s.url, model: 'embeddinggemma-2' });
    assert.ok(ids.includes('nomic-embed-text-v1'));
    assert.ok(ids.includes('plain-single-model-server'), 'a single-model server has no status: listed means served');
    assert.ok(!ids.includes('embeddinggemma-2'), 'an unloaded preset is not served');
  } finally { s.close(); }
});

// ── delete protection ─────────────────────────────────────────────────────────────────────────

test('unmanaged service: the env name stays protected (pre-#1668 behaviour)', () => {
  assert.equal(isSidecarModel('nomic-embed-text-v1', { EMBEDDING_MODEL: 'nomic-embed-text-v1' }), true);
});

test('managed service: protection follows the saved set and running state, the env name is only a seed', async () => {
  const loader = fakeLoader({ models: [GEMMA] });
  await installService(loader);
  const env = { EMBEDDING_MODEL: 'nomic-embed-text-v1' };
  assert.equal(isSidecarModel('nomic-embed-text-v1', env), false, 'the env seed no longer pins nomic');
  assert.equal(isSidecarModel('embeddinggemma-2', env), true, 'the model the service serves is protected');
  assert.ok(sidecarModelNames(env).has(GEMMA.file), 'and by file');
});

test('managed service: a model the router still reports loaded is protected even if the set dropped it (#336)', async () => {
  const loader = fakeLoader({ models: [GEMMA], loaded: ['embeddinggemma-2', 'nomic-embed-text-v1'] });
  await installService(loader);
  assert.equal(isSidecarModel('nomic-embed-text-v1', {}), true);
});

test('embedding off: the last embedding model can be deleted', async () => {
  const loader = fakeLoader({ models: [] });
  await installService(loader);
  assert.equal(isSidecarModel('nomic-embed-text-v1', { EMBEDDING_MODEL: 'nomic-embed-text-v1' }), false);
});

test('stale service status fails closed: env names and last known set are protected', async () => {
  const loader = fakeLoader({ models: [GEMMA] });
  const clock = { t: 0 };
  await installService(loader, LOADER_ENV, clock);
  loader.state.up = false;
  clock.t = 60000;
  const env = { EMBEDDING_MODEL: 'nomic-embed-text-v1' };
  assert.equal(isSidecarModel('nomic-embed-text-v1', env), true);
  assert.equal(isSidecarModel('embeddinggemma-2', env), true);
});

test('a configured embedding model on the inference engine (baseUrl null) stays protected while managed', async () => {
  const loader = fakeLoader({ models: [] });
  await installService(loader);
  embeddingConfigModule.install(createEmbeddingConfig({ env: { EMBEDDING_MODEL: 'engine-embed' }, log: () => {} }));
  assert.equal(isSidecarModel('engine-embed', {}), true);
});

// ── route: switch / finish / off ──────────────────────────────────────────────────────────────

function fakeRag(svcState) {
  const calls = [];
  return {
    calls,
    listIndexes: () => [],
    indexCoverage: () => ({ chunks: 0, vectors: 0 }),
    fillMissing: async () => ({ attempted: 0, embedded: 0, refused: [], remaining: 0 }),
    dropIndexSlot: () => {},
    embed: async () => [[1, 0]],
    servedModels: async (t) => { calls.push(t.baseUrl); return svcState.loaded; },
  };
}

/** A fake Diary sidecar: its own active/next/previous, moved by the actions web sends it. */
function fakeDiary({ notReadyOnSwitch = false } = {}) {
  const t = (model) => ({ base_url: `${SVC}/v1`, model, profile: model });
  const state = { active: t('nomic-embed-text-v1'), next: null, previous: null };
  const calls = [];
  const handle = (body) => {
    if (!body.action) return { ok: true, status: 200, body: { ...state } };
    calls.push(body);
    if (body.action === 'set-next') state.next = { ...body.target };
    else if (body.action === 'clear-next') state.next = null;
    else if (body.action === 'switch') {
      if (notReadyOnSwitch) return { ok: false, status: 409, body: { error: 'The new model has not finished indexing every Diary file yet.', code: 'notReady' } };
      if (state.next) { state.previous = state.active; state.active = state.next; state.next = null; }
    } else if (body.action === 'finish') state.previous = null;
    else if (body.action === 'rollback' && state.previous) { state.active = state.previous; state.previous = null; }
    return { ok: true, status: 200, body: { ok: true } };
  };
  return { state, calls, handle };
}

function harness(loader, { waitTimeoutMs = 10000, diary = fakeDiary() } = {}) {
  // Live spelling: the saved/seeded address carries /v1, the service address does not.
  const config = createEmbeddingConfig({ env: { EMBEDDING_MODEL: 'nomic-embed-text-v1', EMBEDDING_BASE_URL: `${SVC}/v1` }, log: () => {} });
  const fr = fakeRag(loader.state);
  const migration = createEmbeddingMigration({ config, rag: fr, env: {}, sleep: async () => {}, log: () => {} });
  const diaryCalls = diary.calls;
  const fetchJson = async (url, init) => diary.handle(JSON.parse(init.body || '{}'));
  return { config, migration, diaryCalls, diary, fr, routesFor: (svc) => createEmbeddingRoutes({
    json: (res, status, body) => { res.status = status; res.body = body; return true; },
    readJson: async (req) => req.body, migration, authService: { audit: () => {} }, fetchJson, DIARY_BASE: 'http://diary:8000',
    checkAddress: async () => ({ ok: true }), servedModels: async () => loader.state.loaded,
    service: svc, waitTimeoutMs,
    resolveFile: (model) => require('../../server/embedding-service.cjs').resolveModelFile({ env: LOADER_ENV, fetchJson: loader.fetchJson, model }),
  }) };
}

async function post(routes, body) {
  const res = { setHeader() {} };
  await routes({ method: 'POST', body }, res, { path: '/api/embedding', authn: { user: { id: 'admin', role: 'admin' } } });
  return res;
}

test('switch: the service serves old + new, waits for the new alias, re-indexes both sides on its one address, finish frees the old model', async () => {
  const loader = fakeLoader();
  const svc = await installService(loader);
  const h = harness(loader);
  const routes = h.routesFor(svc);
  try {
    const r = await post(routes, { action: 'service-switch', model: 'embeddinggemma-2', profile: 'embeddinggemma-2' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(loader.state.puts[0], ['nomic-embed-text-v1', 'embeddinggemma-2'], 'the active model keeps serving search during the re-index');
    assert.equal(h.config.next().model, 'embeddinggemma-2');
    assert.equal(h.config.next().baseUrl, `${SVC}/v1`, 'the same server keeps the active target\'s spelling');
    const diarySetNext = h.diaryCalls.find((c) => c.action === 'set-next');
    assert.equal(diarySetNext.target.base_url, `${SVC}/v1`, 'the Diary gets the same known address (diaryEndpointRequired)');
    assert.equal(isSidecarModel('nomic-embed-text-v1', {}), true, 'still serving search: not deletable');
    assert.equal((await post(routes, { action: 'switch' })).status, 200);
    assert.equal(isSidecarModel('nomic-embed-text-v1', {}), true, 'kept for rollback until finish');
    const fin = await post(routes, { action: 'finish' });
    assert.equal(fin.status, 200, JSON.stringify(fin.body));
    assert.deepEqual(loader.state.puts.at(-1), ['embeddinggemma-2'], 'finish: the service serves only the new model');
    assert.equal(isSidecarModel('nomic-embed-text-v1', {}), true, 'until the router has dropped it');
    await svc.refresh();
    assert.equal(isSidecarModel('nomic-embed-text-v1', { EMBEDDING_MODEL: 'nomic-embed-text-v1' }), false, 'the old model is deletable now');
  } finally { h.migration.stop(); }
});

test('switch refused when the service never reports the new alias loaded (identity mismatch): nothing re-indexed', async () => {
  const loader = fakeLoader({ loadOnServe: false });
  const svc = await installService(loader);
  const h = harness(loader, { waitTimeoutMs: 6000 });
  try {
    const r = await post(h.routesFor(svc), { action: 'service-switch', model: 'embeddinggemma-2', profile: 'embeddinggemma-2' });
    assert.equal(r.status, 504);
    assert.equal(r.body.code, 'serviceNotLoaded');
    assert.deepEqual(loader.state.puts.at(-1), ['nomic-embed-text-v1'], 'rolled back: the model that did not load is not left served');
    assert.equal(h.config.next(), null, 'no re-index under a model the server did not load');
    assert.equal(h.diaryCalls.length, 0);
  } finally { h.migration.stop(); }
});

test('switch to a model that is not installed is refused before the service is touched', async () => {
  const loader = fakeLoader();
  const svc = await installService(loader);
  const h = harness(loader);
  try {
    const r = await post(h.routesFor(svc), { action: 'service-switch', model: 'not-installed', profile: 'nomic-v1' });
    assert.equal(r.status, 404);
    assert.deepEqual(loader.state.puts, []);
  } finally { h.migration.stop(); }
});

test('turn embedding off: the service stops, search says off and refuses fast, no error is thrown at callers', async () => {
  const loader = fakeLoader();
  const svc = await installService(loader);
  const h = harness(loader);
  embeddingConfigModule.install(h.config);
  rag.init({ dataDir: require('node:os').tmpdir(), embeddingConfig: h.config });
  try {
    const r = await post(h.routesFor(svc), { action: 'service-off' });
    assert.equal(r.status, 200);
    assert.deepEqual(loader.state.puts.at(-1), []);
    assert.equal(svc.enabled(), false);
    assert.equal(rag.embeddingOff(), true);
    assert.equal(await rag.retrievalStatus().catch(() => 'unavailable') === 'off' || !rag.ragAvailable(), true);
    await assert.rejects(rag.embed(['x']), (e) => e.code === 'embeddingOff');
    assert.equal(isSidecarModel('nomic-embed-text-v1', { EMBEDDING_MODEL: 'nomic-embed-text-v1' }), false, 'the last model is deletable');
    // Back on with the same model: no re-index needed.
    const on = await post(h.routesFor(svc), { action: 'service-switch', model: 'nomic-embed-text-v1', profile: 'nomic-v1' });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    assert.equal(h.config.next(), null);
    assert.equal(svc.enabled(), true);
  } finally { h.migration.stop(); }
});

test('turning off is refused while a re-index is under way', async () => {
  const loader = fakeLoader();
  const svc = await installService(loader);
  const h = harness(loader);
  try {
    await post(h.routesFor(svc), { action: 'service-switch', model: 'embeddinggemma-2', profile: 'embeddinggemma-2' });
    const r = await post(h.routesFor(svc), { action: 'service-off' });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'reindexUnderway');
  } finally { h.migration.stop(); }
});

test('service actions need a managed service', async () => {
  const loader = fakeLoader();
  const h = harness(loader);
  try {
    const r = await post(h.routesFor(null), { action: 'service-off' });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'notManaged');
  } finally { h.migration.stop(); }
});

// ── a chat load never evicts embeddings ───────────────────────────────────────────────────────

test('a chat model load only ever talks to the chat engine, never to the embedding service', async () => {
  const urls = [];
  const state = { 'chat-a': 'loaded', 'chat-b': 'unloaded' };
  const manager = require('../../server/llamacpp-manager.cjs').createLlamaCppManager({ unloadWait: { timeoutMs: 0 }, baseUrl: 'http://llama:8080', fetchJson: async (url, options = {}) => {
    urls.push(url);
    const route = new URL(url).pathname, body = options.body ? JSON.parse(options.body) : {};
    if (route === '/models') return { ok: true, status: 200, body: { data: Object.entries(state).map(([id, value]) => ({ id, status: { value } })) } };
    if (route === '/models/unload') { state[body.model] = 'unloaded'; return { ok: true, status: 200, body: { success: true } }; }
    if (route === '/models/load') { state[body.model] = 'loaded'; return { ok: true, status: 200, body: { success: true } }; }
    throw Error(`unexpected ${route}`);
  } });
  await manager.load('chat-b');
  assert.ok(urls.length > 0);
  assert.ok(urls.every((u) => u.startsWith('http://llama:8080/')), urls.join(', '));
  assert.ok(!urls.some((u) => u.startsWith(SVC)));
});

// ── Models page overview row ──────────────────────────────────────────────────────────────────

test('overview: a managed service offers every installed embedding model and "turn off"; off reads off', () => {
  const { modelAssignments } = require('../../server/model-assignments.cjs');
  const installed = [{ name: 'nomic-embed-text-v1', labels: ['embedding'] }, { name: 'embeddinggemma-2', labels: ['embedding'] }, { name: 'chat-a' }];
  const embedding = { active: { model: 'nomic-embed-text-v1', profile: 'nomic-v1', baseUrl: SVC }, next: null };
  const on = modelAssignments({ installed, embedding, admin: true, served: ['nomic-embed-text-v1'], service: { managed: true, enabled: true } }).services[0];
  assert.equal(on.managed, true);
  assert.equal(on.canTurnOff, true);
  assert.deepEqual(on.options, [{ model: 'embeddinggemma-2', profile: 'embeddinggemma-2', served: true }], 'not yet served is fine: the service loads it first');
  const off = modelAssignments({ installed, embedding, admin: true, service: { managed: true, enabled: false } }).services[0];
  assert.equal(off.state, 'off');
  assert.equal(off.canTurnOff, false);
  assert.deepEqual(off.options.map((o) => o.model), ['nomic-embed-text-v1', 'embeddinggemma-2'], 'turning back on may pick the same model');
  const unmanaged = modelAssignments({ installed, embedding, admin: true, served: ['nomic-embed-text-v1'] }).services[0];
  assert.equal(unmanaged.managed, undefined);
  assert.equal(unmanaged.options[0].served, false, 'unmanaged: unchanged #1660 behaviour');
  const member = modelAssignments({ installed, embedding, admin: false, service: { managed: true, enabled: true } }).services[0];
  assert.equal(member.canTurnOff, undefined);
  assert.equal(member.options, undefined);
});

test('addresses with and without /v1 or a trailing slash name the same service', () => {
  const { sameAddress } = require('../../server/embedding-service.cjs');
  assert.equal(sameAddress('http://embed:8080/v1', 'http://embed:8080'), true);
  assert.equal(sameAddress('http://embed:8080/', 'http://embed:8080/v1/'), true);
  assert.equal(sameAddress('http://embed-next:8080/v1', 'http://embed:8080'), false);
  assert.equal(sameAddress(null, 'http://embed:8080'), false);
});

// ── review fixes ──────────────────────────────────────────────────────────────────────────────

test('finish keeps the Diary\'s model served while the Diary has not switched (notReady)', async () => {
  const loader = fakeLoader();
  const svc = await installService(loader);
  const h = harness(loader, { diary: fakeDiary({ notReadyOnSwitch: true }) });
  const routes = h.routesFor(svc);
  try {
    assert.equal((await post(routes, { action: 'service-switch', model: 'embeddinggemma-2', profile: 'embeddinggemma-2' })).status, 200);
    const sw = await post(routes, { action: 'switch' });
    assert.equal(sw.status, 207, JSON.stringify(sw.body));
    const fin = await post(routes, { action: 'finish' });
    assert.ok([200, 207].includes(fin.status), JSON.stringify(fin.body));
    const last = loader.state.puts.at(-1);
    assert.ok(last.includes('nomic-embed-text-v1'), `the Diary still searches with the old model: ${JSON.stringify(last)}`);
    assert.ok(last.includes('embeddinggemma-2'));
  } finally { h.migration.stop(); }
});

test('finish never shrinks the service when the Diary\'s state is unknown', async () => {
  const loader = fakeLoader();
  const svc = await installService(loader);
  const diary = fakeDiary();
  const h = harness(loader, { diary });
  const routes = h.routesFor(svc);
  try {
    await post(routes, { action: 'service-switch', model: 'embeddinggemma-2', profile: 'embeddinggemma-2' });
    await post(routes, { action: 'switch' });
    const puts = loader.state.puts.length;
    const handle = diary.handle;
    diary.handle = (body) => (body.action ? handle(body) : { ok: false, status: 503, body: { error: 'down' } });
    await post(routes, { action: 'finish', scope: 'projects' });
    assert.equal(loader.state.puts.length, puts, 'no PUT: the old model may still serve the Diary');
  } finally { h.migration.stop(); }
});

test('a timed-out switch from off turns the service back off', async () => {
  const loader = fakeLoader({ models: [], loadOnServe: false });
  const svc = await installService(loader);
  const h = harness(loader, { waitTimeoutMs: 6000 });
  try {
    const r = await post(h.routesFor(svc), { action: 'service-switch', model: 'embeddinggemma-2', profile: 'embeddinggemma-2' });
    assert.equal(r.status, 504);
    assert.deepEqual(loader.state.puts, [['embeddinggemma-2'], []]);
    assert.equal(svc.enabled(), false);
  } finally { h.migration.stop(); }
});

test('service-switch is refused while the last switch still keeps its rollback model', async () => {
  const loader = fakeLoader();
  const svc = await installService(loader);
  const h = harness(loader);
  const routes = h.routesFor(svc);
  try {
    await post(routes, { action: 'service-switch', model: 'embeddinggemma-2', profile: 'embeddinggemma-2' });
    assert.equal((await post(routes, { action: 'switch' })).status, 200);
    const puts = loader.state.puts.length;
    const r = await post(routes, { action: 'service-switch', model: 'nomic-embed-text-v1', profile: 'nomic-v1' });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'finishFirst');
    assert.equal(loader.state.puts.length, puts);
  } finally { h.migration.stop(); }
});

test('concurrent service actions run one at a time and see each other\'s result', async () => {
  const loader = fakeLoader();
  const svc = await installService(loader);
  const h = harness(loader);
  const routes = h.routesFor(svc);
  try {
    const [a, b] = await Promise.all([
      post(routes, { action: 'service-switch', model: 'embeddinggemma-2', profile: 'embeddinggemma-2' }),
      post(routes, { action: 'service-off' }),
    ]);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(b.status, 409, 'off sees the re-index the switch started');
    assert.equal(b.body.code, 'reindexUnderway');
    assert.deepEqual(loader.state.puts, [['nomic-embed-text-v1', 'embeddinggemma-2']]);
  } finally { h.migration.stop(); }
});

test('an unconfigured Diary is reported with code notConfigured, so web can tell it from a refusal', async () => {
  const { migration } = harness(fakeLoader());
  try {
    const routes = createEmbeddingRoutes({ json: (res, status, body) => { res.status = status; res.body = body; return true; }, readJson: async (req) => req.body, migration, authService: {}, fetchJson: async () => { throw Error('unused'); } });
    const r = await post(routes, { action: 'clear-next' });
    assert.equal(r.body.diary.code, 'notConfigured');
  } finally { migration.stop(); }
});

// ── re-review #1675 #1676 #1679 ───────────────────────────────────────────────────────────────

const BGE = { model: 'bge-small', file: 'bge-small/bge-small-Q8_0.gguf' };

test('#1675 service-switch keeps the Diary\'s active model: a third model that does not fit is refused, B is never dropped', async () => {
  // Projects active A (nomic), Diary active B (gemma), both on the service; switch to C.
  const loader = fakeLoader({ models: [NOMIC, GEMMA], installed: [NOMIC, GEMMA, BGE] });
  const svc = await installService(loader);
  const diary = fakeDiary();
  diary.state.active = { base_url: `${SVC}/v1`, model: 'embeddinggemma-2', profile: 'embeddinggemma-2' };
  const h = harness(loader, { diary });
  try {
    const r = await post(h.routesFor(svc), { action: 'service-switch', model: 'bge-small', profile: 'nomic-v1' });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.deepEqual(loader.state.puts, [], 'nothing was served without the Diary\'s model');
    assert.equal(h.config.next(), null);
  } finally { h.migration.stop(); }
});

test('#1675 service-switch is refused when the Diary\'s targets cannot be read', async () => {
  const loader = fakeLoader();
  const svc = await installService(loader);
  const diary = fakeDiary();
  diary.handle = () => ({ ok: false, status: 502, body: { error: 'down' } });
  const h = harness(loader, { diary });
  try {
    const r = await post(h.routesFor(svc), { action: 'service-switch', model: 'embeddinggemma-2', profile: 'embeddinggemma-2' });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.code, 'diaryUnknown');
    assert.deepEqual(loader.state.puts, []);
  } finally { h.migration.stop(); }
});

test('#1676 turning off is refused while the last switch is not finished (its rollback model is still served)', async () => {
  const loader = fakeLoader();
  const svc = await installService(loader);
  const h = harness(loader);
  const routes = h.routesFor(svc);
  try {
    assert.equal((await post(routes, { action: 'service-switch', model: 'embeddinggemma-2', profile: 'embeddinggemma-2' })).status, 200);
    assert.equal((await post(routes, { action: 'switch' })).status, 200);
    assert.ok(h.config.previous(), 'a rollback target exists');
    const r = await post(routes, { action: 'service-off' });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'finishFirst');
    assert.notDeepEqual(loader.state.puts.at(-1), []);
  } finally { h.migration.stop(); }
});

test('#1679 a Diary-only finish also syncs the service, so the old model leaves it', async () => {
  const loader = fakeLoader();
  const svc = await installService(loader);
  const h = harness(loader);
  const routes = h.routesFor(svc);
  try {
    assert.equal((await post(routes, { action: 'service-switch', model: 'embeddinggemma-2', profile: 'embeddinggemma-2' })).status, 200);
    assert.equal((await post(routes, { action: 'switch' })).status, 200);
    assert.equal((await post(routes, { action: 'finish', scope: 'projects' })).status, 200);
    assert.deepEqual(loader.state.puts.at(-1), ['embeddinggemma-2', 'nomic-embed-text-v1'], 'the Diary still has nomic for rollback');
    const r = await post(routes, { action: 'finish', scope: 'diary' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(loader.state.puts.at(-1), ['embeddinggemma-2'], 'the Diary finish dropped nomic from the service');
  } finally { h.migration.stop(); }
});

// ── #1681: off waits for the Diary's half of a switch too ─────────────────────────────────────

test('#1681 turning off is refused while the Diary is still mid-switch, even when projects finished', async () => {
  const loader = fakeLoader();
  const svc = await installService(loader);
  const diary = fakeDiary({ notReadyOnSwitch: true });
  const h = harness(loader, { diary });
  const routes = h.routesFor(svc);
  try {
    assert.equal((await post(routes, { action: 'service-switch', model: 'embeddinggemma-2', profile: 'embeddinggemma-2' })).status, 200);
    await post(routes, { action: 'switch' }); // projects switch; the Diary is not ready yet
    assert.equal((await post(routes, { action: 'finish', scope: 'projects' })).status, 200);
    assert.equal(h.config.next(), null);
    assert.equal(h.config.previous(), null, 'the projects side is finished');
    assert.ok(diary.state.next, 'the Diary still has its next target');
    const putsBefore = loader.state.puts.length;
    const r = await post(routes, { action: 'service-off' });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.code, 'finishFirst');
    assert.equal(loader.state.puts.length, putsBefore, 'the service was not stopped');
    // The Diary finished the switch but keeps its rollback target: still refused.
    diary.state.previous = diary.state.active; diary.state.active = diary.state.next; diary.state.next = null;
    assert.equal((await post(routes, { action: 'service-off' })).body.code, 'finishFirst');
    diary.state.previous = null;
    assert.equal((await post(routes, { action: 'service-off' })).status, 200);
    assert.deepEqual(loader.state.puts.at(-1), []);
  } finally { h.migration.stop(); }
});

test('#1681 turning off is refused when the configured Diary cannot be read', async () => {
  const loader = fakeLoader();
  const svc = await installService(loader);
  const diary = fakeDiary();
  diary.handle = () => ({ ok: false, status: 502, body: { error: 'down' } });
  const h = harness(loader, { diary });
  try {
    const r = await post(h.routesFor(svc), { action: 'service-off' });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.code, 'diaryUnknown');
    assert.deepEqual(loader.state.puts, []);
  } finally { h.migration.stop(); }
});

test('#1681 with no Diary configured, turning off is not blocked by it', async () => {
  const loader = fakeLoader();
  const svc = await installService(loader);
  const config = createEmbeddingConfig({ env: { EMBEDDING_MODEL: 'nomic-embed-text-v1', EMBEDDING_BASE_URL: `${SVC}/v1` }, log: () => {} });
  const migration = createEmbeddingMigration({ config, rag: fakeRag(loader.state), env: {}, sleep: async () => {}, log: () => {} });
  const routes = createEmbeddingRoutes({ json: (res, status, body) => { res.status = status; res.body = body; return true; }, readJson: async (req) => req.body, migration, authService: { audit: () => {} },
    fetchJson: async () => { throw new Error('no Diary here'); }, service: svc });
  try {
    const r = await post(routes, { action: 'service-off' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(loader.state.puts.at(-1), []);
  } finally { migration.stop(); }
});

// ── #1683: a Diary target on its default server may be the service ────────────────────────────

for (const base of ['', null]) {
  test(`#1683 a Diary target with base_url ${JSON.stringify(base)} (its default server) keeps its model on the service`, async () => {
    const loader = fakeLoader({ models: [NOMIC, GEMMA] });
    const svc = await installService(loader);
    const diary = fakeDiary();
    diary.state.active = { base_url: base, model: 'embeddinggemma-2', profile: 'embeddinggemma-2' };
    const h = harness(loader, { diary });
    try {
      const r = await post(h.routesFor(svc), { action: 'clear-next', scope: 'projects' }); // any sync
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(loader.state.puts.at(-1), ['nomic-embed-text-v1', 'embeddinggemma-2'], 'the Diary\'s default-server model stays served');
    } finally { h.migration.stop(); }
  });
}

// ── #1686: an address-less Diary target is reported as such, not as "finish the switch" ─────

test('#1686 projects on Z, Diary on X at its default server: switching to Y is refused with diaryAddressUnknown', async () => {
  // X is served (its file known) but the Diary names no address for it.
  const X = { model: 'diary-default-embed', file: 'diary-default-embed/diary-default-embed-Q8_0.gguf' };
  const loader = fakeLoader({ models: [NOMIC, X], installed: [NOMIC, GEMMA, X] });
  const svc = await installService(loader);
  const diary = fakeDiary();
  diary.state.active = { base_url: null, model: X.model, profile: 'nomic-v1' };
  const h = harness(loader, { diary });
  try {
    loader.state.puts.length = 0;
    const r = await post(h.routesFor(svc), { action: 'service-switch', model: 'embeddinggemma-2', profile: 'embeddinggemma-2' });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.code, 'diaryAddressUnknown');
    assert.match(r.body.error, /explicit embeddings address/);
    assert.deepEqual(loader.state.puts, []);
  } finally { h.migration.stop(); }
});

test('#1686 a real two-model overflow on the service is still tooManyModels', async () => {
  const THIRD = { model: 'third-embed', file: 'third-embed/third-embed-Q8_0.gguf' };
  const loader = fakeLoader({ models: [NOMIC, GEMMA], installed: [NOMIC, GEMMA, THIRD] });
  const svc = await installService(loader);
  const diary = fakeDiary();
  diary.state.active = { base_url: `${SVC}/v1`, model: 'embeddinggemma-2', profile: 'embeddinggemma-2' };
  const h = harness(loader, { diary });
  try {
    const r = await post(h.routesFor(svc), { action: 'service-switch', model: THIRD.model, profile: 'nomic-v1' });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.code, 'tooManyModels');
  } finally { h.migration.stop(); }
});

// ── #1687: the Diary always reports an active target; a reply without one stays unknown ──────

test('#1687 a configured Diary answering active: null is not taken as known-empty (the Diary never sends that)', async () => {
  const loader = fakeLoader();
  const svc = await installService(loader);
  const diary = fakeDiary();
  diary.handle = () => ({ ok: true, status: 200, body: { active: null, next: null, previous: null } });
  const h = harness(loader, { diary });
  try {
    assert.equal((await post(h.routesFor(svc), { action: 'service-off' })).body.code, 'diaryUnknown');
    assert.equal((await post(h.routesFor(svc), { action: 'service-switch', model: 'embeddinggemma-2', profile: 'embeddinggemma-2' })).body.code, 'diaryUnknown');
    assert.deepEqual(loader.state.puts, []);
  } finally { h.migration.stop(); }
});
