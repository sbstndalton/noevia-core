'use strict';
// #2262: GET inference-budget and GET installed are the Rust front's. Node refuses them before authentication, keeps the PUT
// and the figure it enforces, and offers the front what only it has on the loopback check.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const { OWNED_PATHS, ROUTE_REFUSAL, owned, refuseOwned } = require('./rust-model-state-reads.cjs');
const { createModelFactsBridge, PATH } = require('./rust-model-facts.cjs');
const { createInferenceBudget } = require('./inference-budget.cjs');
const { createModelService } = require('./models.cjs');
const { json, readJson } = require('./http.cjs');

const SECRET = 's'.repeat(40);
const parseRequestUrl = (req, base = 'http://localhost') => { try { return new URL(req.url, base); } catch { return null; } };

test('the two GETs are refused, whoever asks; the PUT and everything beside them are not', () => {
  assert.equal(ROUTE_REFUSAL.code, 'RUST_MODEL_STATE_READS_OWNED');
  assert.deepEqual([...OWNED_PATHS], ['/api/models/inference-budget', '/api/models/installed']);
  const seen = [];
  assert.equal(refuseOwned({ method: 'GET', url: '/api/models/installed?x=1', headers: {} }, {}, { parseRequestUrl, json: (_, s, b) => seen.push([s, b]) }), true);
  assert.deepEqual(seen, [[503, ROUTE_REFUSAL]]);
  for (const [m, p] of [['PUT', '/api/models/inference-budget'], ['POST', '/api/models/installed'], ['GET', '/api/models/machines'], ['GET', '/api/models/installed/']]) assert.equal(owned(m, p), false, `${m} ${p}`);
});

test('index.cjs mounts the refusal and the bridge, on the captured secret, and the old handler and estimates are gone', () => {
  const index = fs.readFileSync(path.join(__dirname, 'index.cjs'), 'utf8');
  assert.match(index, /require\('\.\/rust-model-state-reads\.cjs'\)\.refuseOwned\(req, res, \{ parseRequestUrl, json \}\)/);
  assert.match(index, /await modelFactsBridge\(req, res\)/);
  assert.match(index, /createModelFactsBridge\(\{\n\s*secret: FRONT_SECRET,/);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, 'routes/models.cjs'), 'utf8'), /inferenceEstimates|await modelsInstalled\(\)\)/);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, 'llamacpp-manager.cjs'), 'utf8'), /inferenceEstimates/);
});

async function bridge(deps = {}) {
  const handle = createModelFactsBridge({ secret: SECRET, json, readJson, log: () => {}, inferenceBudget: deps.inferenceBudget ?? { get: () => ({ budgetGib: 12 }) }, service: deps.service ?? { installedFacts: async (q) => ({ asked: q }) } });
  const server = http.createServer(async (req, res) => { if (!await handle(req, res)) { res.statusCode = 599; res.end(); } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const call = async (body, { secret = SECRET, method = 'POST' } = {}) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}${PATH}`, { method, headers: { 'x-noevia-store-token': secret }, ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return { call, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('the budget fact is the figure this process enforces, after a PUT and after a boot fault reading the row', async () => {
  const row = new Map([['inference:memory-budget', JSON.stringify({ budgetGib: 9 })]]);
  const readable = { get: (k) => row.get(k), set: (k, v) => row.set(k, v) };
  const meminfo = () => 'MemTotal:       67108864 kB\n';
  const healthy = createInferenceBudget({ store: readable, env: {}, readMeminfo: meminfo });
  let b = await bridge({ inferenceBudget: healthy });
  assert.equal((await b.call({ want: 'budget' })).body.budget.budgetGib, 9);
  healthy.save({ budgetGib: 20 }, 'u1');
  assert.deepEqual([(await b.call({ want: 'budget' })).body.budget.budgetGib, (await b.call({ want: 'budget' })).body.budget.source], [20, 'admin']);
  await b.close();
  // The row is there, this process could not read it at boot: it enforces the deployment's figure, so that is the answer.
  const faulted = createInferenceBudget({ store: { get: () => { throw Error('database is locked'); }, set: readable.set }, env: { INFERENCE_MEMORY_BUDGET_GIB: '6' }, readMeminfo: meminfo });
  b = await bridge({ inferenceBudget: faulted });
  const after = (await b.call({ want: 'budget' })).body.budget;
  assert.deepEqual([after.budgetGib, after.source], [6, 'deployment']);
  await b.close();
});

test('the bridge is an unknown path to anyone else, refuses a malformed call and hides a fault', async () => {
  const b = await bridge();
  try {
    assert.equal((await b.call({ want: 'budget' }, { secret: 'wrong' })).status, 404);
    assert.equal((await b.call(null, { method: 'GET' })).status, 404);
    for (const bad of ['{bad', { want: 'secrets' }, { want: 'installed' }, { want: 'installed', ids: [1] }, { want: 'installed', ids: [], firstLoaded: 1 }, { want: 'installed', ids: Array(4097).fill('m') }]) assert.equal((await b.call(bad)).status, 400, JSON.stringify(bad).slice(0, 40));
    assert.deepEqual((await b.call({ want: 'installed', ids: ['m'], scan: true })).body, { asked: { ids: ['m'], scan: true } });
  } finally { await b.close(); }
  const broken = await bridge({ service: { installedFacts: async () => { throw Error('secret detail'); } } });
  try {
    const r = await broken.call({ want: 'installed', ids: [] });
    assert.equal(r.status, 503);
    assert.doesNotMatch(JSON.stringify(r.body), /secret detail/);
  } finally { await broken.close(); }
});

test('installedFacts: sidecar names and reports, one scan, and the first loaded model is remembered once', async () => {
  const fetched = [];
  const env = { MODEL_LOADER_URL: 'http://loader', EMBEDDING_MODEL: 'syn-embed' };
  const fetchJson = async (url) => {
    fetched.push(url);
    if (url.endsWith('/backends')) return { ok: true, body: { backends: [{ status: 'running', loaded_model: 'syn-embed, other' }, { status: 'stopped', loaded_model: 'no' }] } };
    return { ok: true, body: { models: [{ modelId: 'syn-chat', sections: ['syn-chat'], bytes: 5e9, shape: { layers: 1 }, secretPath: '/data/x' }] } };
  };
  const service = createModelService({ fetchJson, env, modelManager: {}, currentWorkspace: () => ({}) });
  const [a, b] = await Promise.all([
    service.installedFacts({ ids: ['syn-chat', 'syn-embed'], scan: true, firstLoaded: 'syn-chat' }),
    service.installedFacts({ ids: ['syn-chat'], scan: true, firstLoaded: 'later' }),
  ]);
  assert.deepEqual(a, { sidecarNames: ['syn-embed'], sidecarLoaded: ['syn-embed', 'other'], scan: [{ modelId: 'syn-chat', sections: ['syn-chat'], bytes: 5e9, shape: { layers: 1 } }] });
  assert.deepEqual(b.sidecarLoaded, [], 'no sidecar among the ids: the loader is not asked');
  assert.equal(service.lastLoadedModel(), 'syn-chat');
  assert.equal(fetched.filter((u) => u.endsWith('/models')).length, 1, 'concurrent cold reads share one scan');
  const none = await service.installedFacts({ ids: [], scan: false });
  assert.equal(none.scan, null);
});
