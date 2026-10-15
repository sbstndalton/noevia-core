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
