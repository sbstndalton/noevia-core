'use strict';
// #1856: Settings → Inference machines health. A service that answers 401 is up (needs auth), the decision probe
// sends the decision client's own key to its own host only, "this machine" asks the model loader / provider the app
// really uses, and every non-healthy state carries a short reason. Synthetic addresses only.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMachineHealth, machineState, machineReason } = require('./machine-health.cjs');
const { createDecisionSettings } = require('./decision-settings.cjs');
const { createInferenceMachineRoutes } = require('./routes/inference-machines.cjs');

const reply = (status) => ({ ok: status >= 200 && status < 300, status, body: { cancel: async () => {} } });
const refuse = (code, name = 'TypeError') => Object.assign(new Error('fetch failed'), { name, cause: { code } });

function health(fetchImpl) { return createMachineHealth({ fetchImpl, decisionFetchImpl: fetchImpl, ttlMs: 0 }); }

test('401/403 with no key is up (needs auth), not an error', async () => {
  const h = health(async () => reply(401));
  assert.deepEqual((await h.check([{ service: 'decision', url: 'http://kev:11435', decision: true }])).decision.state, 'up');
  assert.equal((await health(async () => reply(403)).check([{ service: 'x', url: 'http://kev:11435' }])).x.reason, 'needs-auth');
});

test('a key that was sent and refused is down with http-401; other statuses read http-NNN', async () => {
  const r = await health(async () => reply(401)).check([{ service: 'decision', url: 'http://kev:11435', headers: { Authorization: 'Bearer k' } }]);
  assert.deepEqual([r.decision.state, r.decision.reason], ['down', 'http-401']);
  const s = await health(async () => reply(503)).check([{ service: 'a', url: 'http://pi:1' }]);
  assert.deepEqual([s.a.state, s.a.reason], ['down', 'http-503']);
});

test('unreachable reasons: refused, timeout, not-found, not-on-this-network, network', async () => {
  const cases = [[refuse('ECONNREFUSED'), 'refused'], [Object.assign(new Error('t'), { name: 'TimeoutError' }), 'timeout'], [refuse('ENOTFOUND'), 'not-found'],
    [Object.assign(new Error('p'), { code: 'EPUBLICADDR' }), 'not-on-this-network'], [new Error('weird'), 'network']];
  for (const [err, reason] of cases) {
    const r = await health(async () => { throw err; }).check([{ service: 'a', url: 'http://pi:1' }]);
    assert.deepEqual([r.a.state, r.a.reason], ['unreachable', reason]);
  }
});

test('a target path and headers are used as given', async () => {
  const seen = [];
  const h = health(async (url, init) => { seen.push([url, init.headers]); return reply(200); });
  await h.check([{ service: 'engine', url: 'http://loader:9000', path: '/api/v1/models', headers: { 'X-Model-Loader-Token': 't' } }]);
  assert.deepEqual(seen, [['http://loader:9000/api/v1/models', { 'X-Model-Loader-Token': 't' }]]);
});

test('machineReason: the worst service reason, empty when healthy', () => {
  assert.equal(machineReason([{ state: 'up' }, { state: 'down', reason: 'http-503' }, { state: 'unreachable', reason: 'refused' }]), 'refused');
  assert.equal(machineReason([{ state: 'down', reason: 'http-503' }]), 'http-503');
  assert.equal(machineReason([{ state: 'up', reason: 'needs-auth' }]), '');
  assert.equal(machineState([{ state: 'up', reason: 'needs-auth' }]), 'up');
});

function decisionFixture({ url, env, machine = null }) {
  const store = { get: () => undefined, set() {}, delete() {} };
  return createDecisionSettings({ store, env: { COWORK_DECISION_URL: url, COWORK_DECISION_MODEL: 'kev-0.8b', ...env }, machineUrl: () => machine });
}

test('decision backend exposes the client key as a health header for its own host only', () => {
  const own = decisionFixture({ url: 'http://kev:11435', env: { COWORK_DECISION_API_KEY: 'secret-key' } }).backend();
  assert.deepEqual(own.healthHeaders, { Authorization: 'Bearer secret-key' });
  assert.equal(own.baseUrl, 'http://kev:11435');
  // an address from an Inference machine is another host: the shared key is not sent there (#1753)
  const other = decisionFixture({ url: 'http://kev:11435', env: { COWORK_DECISION_API_KEY: 'secret-key' }, machine: 'http://192.168.1.20:8040' }).backend();
  assert.deepEqual(other.healthHeaders, {});
  assert.deepEqual(decisionFixture({ url: 'http://kev:11435', env: {} }).backend().healthHeaders, {});
});

function routeFixture({ engine, authHeaders }) {
  const sent = [], probes = [];
  const machines = { view: () => ({ machines: [{ id: 'local', builtIn: true, services: ['decision', 'chatFast'] }], services: [{ id: 'decision' }] }), chatTarget: () => null };
  const routes = createInferenceMachineRoutes({
    json: (res, status, body) => { sent.push({ status, body }); return true; }, readJson: async () => ({}), machines,
    health: createMachineHealth({ fetchImpl: async (url, init) => { probes.push({ url, headers: init.headers }); return url.includes('kev') ? reply(401) : url.includes('loader') ? reply(200) : reply(404); }, decisionFetchImpl: async (url, init) => { probes.push({ url, headers: init.headers }); return reply(401); }, ttlMs: 0 }),
    effective: { decision: () => 'http://kev:11435' }, engine, authHeaders,
  });
  const call = () => routes({ method: 'GET' }, { setHeader() {} }, { path: '/api/models/machines', authn: { user: { id: 'a', role: 'admin' } }, url: new URL('http://x/api/models/machines?health=1') });
  return { call, sent, probes };
}

test('route: Kev answering 401 with no key is up; this machine probes the model loader it uses, with its token', async () => {
  const f = routeFixture({ engine: () => ({ url: 'http://loader:9000', path: '/api/v1/models', headers: { 'X-Model-Loader-Token': 't' } }), authHeaders: {} });
  await f.call();
  const h = f.sent[0].body.health;
  assert.equal(h.services.decision.state, 'up');
  assert.equal(h.services.engine.state, 'up');
  assert.equal(h.machines.local, 'up');
  assert.deepEqual(h.reasons, {});
  const engineProbe = f.probes.find((p) => p.url.includes('loader'));
  assert.equal(engineProbe.url, 'http://loader:9000/api/v1/models');
  assert.deepEqual(engineProbe.headers, { 'X-Model-Loader-Token': 't' });
});

test('route: the decision key goes only to the decision probe; a refused local engine reads unreachable with its reason', async () => {
  const f = routeFixture({
    engine: () => ({ url: 'http://refused-loader:9000', path: '/api/v1/models', headers: { 'X-Model-Loader-Token': 't' } }),
    authHeaders: { decision: (url) => (new URL(url).hostname === 'kev' ? { Authorization: 'Bearer k' } : null) } });
  await f.call();
  const decisionProbe = f.probes.find((p) => p.url.includes('kev'));
  assert.deepEqual(decisionProbe.headers, { Authorization: 'Bearer k' });
  const engineProbe = f.probes.find((p) => p.url.includes('refused-loader'));
  assert.equal(engineProbe.headers['Authorization'], undefined, 'the decision key is never sent to another host');
  const h = f.sent[0].body.health;
  assert.equal(h.services.decision.state, 'down'); // key sent, 401 back: a rejected key is a fault
  assert.equal(h.reasons.local, 'http-401');
});

// #1861: Kev (OpenAI-style) has no /health; Laya serves it. Real HTTP servers on loopback, synthetic key.
const http = require('node:http');
function fakeServer(handler) {
  return new Promise((resolve) => { const hits = []; const s = http.createServer((req, res) => { hits.push({ url: req.url, auth: req.headers.authorization }); handler(req, res); });
    s.listen(0, '127.0.0.1', () => resolve({ base: `http://127.0.0.1:${s.address().port}`, hits, close: () => s.close() })); });
}
const realHealth = () => createMachineHealth({ fetchImpl: (u, i) => fetch(u, i), decisionFetchImpl: (u, i) => fetch(u, i), ttlMs: 0 });

test('#1861: Kev-like server (no /health, /v1/models 200 with the key) reads up through the fallback', async () => {
  const kev = await fakeServer((req, res) => { if (req.url === '/v1/models' && req.headers.authorization === 'Bearer k') { res.end('{}'); } else { res.statusCode = 404; res.end(); } });
  try {
    const r = await realHealth().check([{ service: 'decision', url: kev.base, decision: true, headers: { Authorization: 'Bearer k' }, fallbackPath: '/v1/models' }]);
    assert.equal(r.decision.state, 'up');
    assert.deepEqual(kev.hits.map((h) => h.url), ['/health', '/v1/models']);
    assert.ok(kev.hits.every((h) => h.auth === 'Bearer k'));
    // without the fallback the 404 is still a plain http-404 fault
    const bare = await realHealth().check([{ service: 'decision', url: kev.base, headers: { Authorization: 'Bearer k' } }]);
    assert.deepEqual([bare.decision.state, bare.decision.reason], ['down', 'http-404']);
  } finally { kev.close(); }
});

test('#1861: a Laya-like server answering /health is asked once, on /health only', async () => {
  const laya = await fakeServer((req, res) => { res.statusCode = req.url === '/health' ? 200 : 404; res.end(); });
  try {
    const r = await realHealth().check([{ service: 'sensitivity', url: laya.base, fallbackPath: '/v1/models' }]);
    assert.equal(r.sensitivity.state, 'up');
    assert.deepEqual(laya.hits.map((h) => h.url), ['/health']);
  } finally { laya.close(); }
});

test('#1861: a fallback that also fails keeps the fallback reason; a 5xx on /health is not retried', async () => {
  const seen = [];
  const h = health(async (url) => { seen.push(new URL(url).pathname); return reply(url.endsWith('/health') ? 404 : 500); });
  const r = await h.check([{ service: 'decision', url: 'http://kev:1', fallbackPath: '/v1/models' }]);
  assert.deepEqual([r.decision.state, r.decision.reason], ['down', 'http-500']);
  seen.length = 0;
  await health(async (url) => { seen.push(url); return reply(503); }).check([{ service: 'decision', url: 'http://kev:1', fallbackPath: '/v1/models' }]);
  assert.equal(seen.length, 1);
});

test('#1861: route reads Kev healthy via /v1/models and names the failing service on a degraded machine', async () => {
  const mk = (decisionStatus) => {
    const sent = [];
    const routes = createInferenceMachineRoutes({
      json: (res, status, body) => { sent.push(body); return true; }, readJson: async () => ({}),
      machines: { view: () => ({ machines: [{ id: 'local', builtIn: true, services: ['decision'] }], services: [] }), chatTarget: () => null },
      health: createMachineHealth({ fetchImpl: async () => reply(200), decisionFetchImpl: async (u) => reply(u.endsWith('/health') ? 404 : decisionStatus), ttlMs: 0 }),
      effective: { decision: () => 'http://kev:11435' }, engine: () => ({ url: 'http://loader:9000', path: '/api/v1/models' }), authHeaders: {} });
    return { sent, call: () => routes({ method: 'GET' }, { setHeader() {} }, { path: '/api/models/machines', authn: { user: { id: 'a', role: 'admin' } }, url: new URL('http://x/api/models/machines?health=1') }) };
  };
  const ok = mk(200); await ok.call();
  assert.equal(ok.sent[0].health.services.decision.state, 'up');
  assert.deepEqual(ok.sent[0].health.failing, {});
  const bad = mk(500); await bad.call();
  assert.equal(bad.sent[0].health.machines.local, 'down');
  assert.deepEqual([bad.sent[0].health.reasons.local, bad.sent[0].health.failing.local], ['http-500', 'decision']);
});
