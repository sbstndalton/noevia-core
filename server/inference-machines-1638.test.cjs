'use strict';
// #1638: Settings → Inference machines. The registry (inference-machines.cjs), the consumers that read
// their address from it (decision-settings.cjs, rerank-settings.cjs, llamacpp-manager.cjs keepAlongside),
// the bounded health probe (machine-health.cjs) and the admin-only route. Synthetic addresses only.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createInferenceMachines, normalizeAddress, KEY } = require('./inference-machines.cjs');
const { createDecisionSettings } = require('./decision-settings.cjs');
const { createRerankSettings } = require('./rerank-settings.cjs');
const { createMachineHealth, machineState } = require('./machine-health.cjs');
const { createInferenceMachineRoutes } = require('./routes/inference-machines.cjs');

function memoryStore(seed = {}) {
  const map = new Map(Object.entries(seed));
  return { get: (k) => map.get(k), set: (k, v) => map.set(k, v), delete: (k) => map.delete(k), map };
}
// DNS for the save-time check: pi5.lan and rock.tailnet.ts.net are private, public.example resolves to a
// public address, mixed.example to one private and one public answer, offline.lan does not resolve.
const ANSWERS = { 'pi5.lan': ['192.168.1.50'], 'rock.tailnet.ts.net': ['100.101.102.103'], 'public.example': ['93.184.216.34'], 'mixed.example': ['10.0.0.9', '93.184.216.34'], laya: ['172.18.0.5'] };
async function lookup(host) {
  if (!ANSWERS[host]) throw Object.assign(Error('not found'), { code: 'ENOTFOUND' });
  return ANSWERS[host].map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
}
function registry({ store = memoryStore(), embedding = { baseUrl: null, model: 'embed-a', profile: 'nomic-v1' }, localEmbeddingUrl = null, changes = [] } = {}) {
  const audits = [];
  const machines = createInferenceMachines({ store, lookup, audit: (action, actor, detail) => audits.push({ action, actor, detail }),
    embeddingActive: () => embedding, localEmbeddingUrl: () => localEmbeddingUrl, onChange: (s) => changes.push(s), log: () => {} });
  return { machines, audits, store, changes };
}

test('default: every service is on this machine and nothing is overridden', () => {
  const { machines } = registry();
  const v = machines.view();
  assert.deepEqual(v.machines.map((m) => m.id), ['local']);
  assert.equal(v.machines[0].builtIn, true);
  assert.deepEqual(v.machines[0].services, ['chatFast', 'chatSmart', 'chatCode', 'chatCreative', 'vision', 'decision', 'embedding', 'reranker', 'ocr']);
  assert.ok(v.services.every((s) => s.machine === 'local'));
  for (const s of ['decision', 'reranker', 'embedding']) assert.equal(machines.urlFor(s), null);
});

test('addresses: LAN, Tailscale and resolving names are accepted; public, mixed, metadata and malformed are refused', async () => {
  const { machines } = registry();
  await machines.add({ name: 'Pi 5', address: '192.168.1.50' }, 'admin');
  await machines.add({ name: 'Rock', address: 'http://rock.tailnet.ts.net' }, 'admin');
  await machines.add({ name: 'Ts', address: '100.64.0.7' }, 'admin');
  await machines.add({ name: 'Ten', address: 'https://10.1.2.3' }, 'admin');
  const named = await machines.add({ name: 'Pi name', address: 'pi5.lan' }, 'admin');
  assert.equal(named.machine.address, 'http://pi5.lan');
  for (const address of ['8.8.8.8', 'http://93.184.216.34', 'public.example', 'mixed.example', '169.254.169.254', '100.100.100.200', '0.0.0.0', '224.0.0.1', 'ftp://10.0.0.1']) {
    await assert.rejects(machines.add({ name: `bad ${address}`, address }, 'admin'), (err) => err.status === 400, address);
  }
  await assert.rejects(machines.add({ name: 'port', address: '10.0.0.1:8080' }, 'admin'), (err) => err.code === 'portInAddress');
  await assert.rejects(machines.add({ name: 'path', address: 'http://10.0.0.1/v1' }, 'admin'), (err) => err.code === 'invalidAddress');
  await assert.rejects(machines.add({ name: 'creds', address: 'http://u:p@10.0.0.1' }, 'admin'), (err) => err.status === 400);
  await assert.rejects(machines.add({ name: '', address: '10.0.0.2' }, 'admin'), (err) => err.code === 'invalidName');
  await assert.rejects(machines.add({ name: 'pi 5', address: '10.0.0.3' }, 'admin'), (err) => err.code === 'duplicateName');
  // A name that does not resolve now is kept, marked unresolved (every consumer checks it again at connect time).
  const offline = await machines.add({ name: 'Offline', address: 'offline.lan' }, 'admin');
  assert.equal(offline.machine.unresolved, true);
  assert.equal(normalizeAddress(' 192.168.0.9 '), 'http://192.168.0.9');
});

test('decision: an assignment overrides the saved URL and COWORK_DECISION_URL; this machine falls back to them', async () => {
  const env = { COWORK_DECISION_URL: 'http://laya:8040', COWORK_DECISION_API_KEY: 'shared-key-123' };
  const { machines, audits } = registry();
  const settings = createDecisionSettings({ store: memoryStore(), env, machineUrl: () => machines.urlFor('decision') });
  assert.equal(settings.get().url, 'http://laya:8040');
  assert.equal(settings.get().source, 'deployment');
  const { machine } = await machines.add({ name: 'Pi 5', address: '192.168.1.50' }, 'admin');
  machines.assign({ service: 'decision', machine: machine.id, port: 8040 }, 'admin');
  assert.equal(machines.urlFor('decision'), 'http://192.168.1.50:8040');
  assert.equal(settings.get().url, 'http://192.168.1.50:8040');
  assert.equal(settings.get().source, 'machine');
  assert.equal(settings.get().timeoutMs, 1500);
  assert.equal(settings.describe().decision.state, 'active');
  // #1845: the clients that switch on `source` (web Decision setup note, Models row note) get 'machine' on both reads.
  assert.equal(settings.describe().decision.source, 'machine');
  // Another host: the deployment's shared key is not sent there (#1753 rule).
  const sent = [];
  const keyed = createDecisionSettings({ store: memoryStore(), env, machineUrl: () => machines.urlFor('decision'),
    fetchImpl: async (url, init) => { sent.push({ url, headers: init.headers }); return new Response(JSON.stringify({ selected: 'a', scores: { a: 0.9, b: 0.1 } })); } });
  await keyed.backend().decide({ question: 'q', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] });
  assert.equal(sent[0].url, 'http://192.168.1.50:8040/v1/decisions');
  assert.equal(sent[0].headers.Authorization, undefined);
  // Back to this machine: the environment applies again.
  machines.assign({ service: 'decision', machine: 'local' }, 'admin');
  assert.equal(settings.get().url, 'http://laya:8040');
  assert.equal(settings.get().source, 'deployment');
  assert.deepEqual(audits.filter((a) => a.action === 'machines.assign').map((a) => a.detail), [
    { service: 'decision', machine: machine.id, port: 8040, from: 'local' },
    { service: 'decision', machine: 'local', from: machine.id },
  ]);
});

test('decision: a machine name that DNS later re-points to 169.254.x is refused at connect time and nothing is sent (#1845)', async () => {
  const { createServiceFetch } = require('./service-endpoint.cjs');
  const { machines } = registry();
  const { machine } = await machines.add({ name: 'Pi 5', address: 'pi5.lan' }, 'admin');
  machines.assign({ service: 'decision', machine: machine.id, port: 8040 }, 'admin');
  // The name now resolves to a link-local address (it was 192.168.1.50 when saved).
  const resolve = (host, _opts, cb) => cb(null, [{ address: '169.254.10.10', family: 4 }]);
  const wire = [];
  const spy = (inner) => (url, init) => { wire.push(String(url)); return inner(url, init); };
  const settings = createDecisionSettings({ store: memoryStore(), env: {}, machineUrl: () => machines.urlFor('decision'),
    fetchImpl: async () => assert.fail('the link-local-allowed fetch must not carry machine traffic'),
    sensitivityFetchImpl: spy(createServiceFetch({ resolve, linkLocal: false })) });
  assert.equal(settings.get().source, 'machine');
  const sendWith = (s) => s.backend().decide({ question: 'q', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] });
  await assert.rejects(sendWith(settings), (e) => !/selected/.test(String(e.message)) && e.reason !== 'too-many-options');
  assert.equal(wire.length, 1, 'the connect was attempted through the link-local-refusing fetch');
  // The same address saved as a URL (not a machine) keeps the link-local-allowed path.
  const saved = [];
  const own = createDecisionSettings({ store: memoryStore({ 'decision:configuration': JSON.stringify({ url: 'http://169.254.10.10:8040', timeoutMs: 1500 }) }), env: {},
    fetchImpl: async (url) => { saved.push(String(url)); return new Response(JSON.stringify({ selected: 'a', scores: { a: 0.9, b: 0.1 } })); },
    sensitivityFetchImpl: async () => assert.fail('saved URL must not use the machine path') });
  assert.equal(own.get().source, 'admin');
  await sendWith(own);
  assert.equal(saved.length, 1);
});

test('reranker: an assignment moves the address and drops the deployment key on another host; env is the fallback', async () => {
  const env = { NOEVIA_FEATURE_RAG_RERANK: 'true', RERANK_BACKEND: 'tei', RERANK_BASE_URL: 'http://rerank:8080', RERANK_API_KEY: 'rk-123' };
  const changes = [];
  const { machines } = registry({ changes });
  const rerank = createRerankSettings({ store: memoryStore(), env, machine: () => { const url = machines.urlFor('reranker'); return url ? { url, protocol: machines.rerankProtocol() } : null; } });
  assert.equal(rerank.effectiveEnv(), env);
  const { machine } = await machines.add({ name: 'Rock', address: 'rock.tailnet.ts.net' }, 'admin');
  machines.assign({ service: 'reranker', machine: machine.id, port: 8080 }, 'admin');
  assert.deepEqual(changes, ['reranker']);
  const e = rerank.effectiveEnv();
  assert.equal(e.RERANK_BASE_URL, 'http://rock.tailnet.ts.net:8080');
  assert.equal(e.RERANK_BACKEND, 'tei');
  assert.equal(e.NOEVIA_FEATURE_RAG_RERANK, 'true');
  assert.equal(e.RERANK_API_KEY, '');
  assert.deepEqual(rerank.get(null).options.map((o) => o.id), ['tei']);
  // A llama.cpp reranker on the machine: its installed presets are the choices.
  machines.assign({ service: 'reranker', machine: machine.id, port: 8081, protocol: 'llamacpp' }, 'admin');
  assert.deepEqual(rerank.get([{ name: 'bge-reranker', labels: ['reranking'] }]).options.map((o) => o.id), ['llamacpp:bge-reranker']);
  assert.throws(() => machines.assign({ service: 'reranker', machine: machine.id, port: 8081, protocol: 'grpc' }, 'admin'), (err) => err.code === 'invalidProtocol');
  machines.assign({ service: 'reranker', machine: 'local' }, 'admin');
  assert.equal(rerank.effectiveEnv(), env);
});

test('residency: a reranker on another machine is not kept beside the chat model on this engine', async () => {
  const keys = ['NOEVIA_FEATURE_RAG_RERANK', 'RERANK_BACKEND', 'RERANK_BASE_URL', 'RERANK_MODEL', 'RERANK_SHARED_ENGINE', 'INFERENCE_BASE_URL', 'EMBEDDING_BASE_URL'];
  const before = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const rs = require('./rerank-settings.cjs');
  const { keepAlongside } = require('./llamacpp-manager.cjs');
  try {
    Object.assign(process.env, { NOEVIA_FEATURE_RAG_RERANK: 'true', RERANK_BACKEND: 'llamacpp', RERANK_BASE_URL: 'http://engine:8080/v1', RERANK_MODEL: 'bge-reranker', RERANK_SHARED_ENGINE: 'allow', INFERENCE_BASE_URL: 'http://engine:8080/v1', EMBEDDING_BASE_URL: 'http://embed:8080/v1' });
    const { machines } = registry();
    rs.install(rs.createRerankSettings({ store: memoryStore(), env: process.env, machine: () => { const url = machines.urlFor('reranker'); return url ? { url, protocol: machines.rerankProtocol() } : null; } }));
    assert.deepEqual(keepAlongside(), ['bge-reranker']);
    const { machine } = await machines.add({ name: 'Pi 5', address: '192.168.1.50' }, 'admin');
    machines.assign({ service: 'reranker', machine: machine.id, port: 8080, protocol: 'llamacpp' }, 'admin');
    assert.deepEqual(keepAlongside(), []);
  } finally {
    rs.install(null);
    for (const k of keys) { if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k]; }
  }
});

test('embeddings move only through the re-index: assign answers the target, the machine follows the active target', async () => {
  const embedding = { baseUrl: null, model: 'embed-a', profile: 'nomic-v1' };
  const { machines, audits } = registry({ embedding, localEmbeddingUrl: 'http://embed:8080/v1' });
  const { machine } = await machines.add({ name: 'Pi 5', address: '192.168.1.50' }, 'admin');
  assert.throws(() => machines.assign({ service: 'embedding', machine: machine.id, port: 8081 }, 'admin'), (err) =>
    err.status === 409 && err.code === 'reindexRequired' && err.target.baseUrl === 'http://192.168.1.50:8081/v1' && err.target.model === 'embed-a' && err.target.profile === 'nomic-v1');
  assert.equal(machines.assignmentOf('embedding').machine, 'local'); // nothing changed
  assert.equal(audits.filter((a) => a.action === 'machines.assign').length, 0);
  // The re-index finished: the active target is on the machine now.
  embedding.baseUrl = 'http://192.168.1.50:8081/v1';
  assert.deepEqual(machines.assignmentOf('embedding'), { machine: machine.id, port: 8081 });
  assert.ok(machines.view().machines.find((m) => m.id === machine.id).services.includes('embedding'));
  // In use: not removable, address not changeable; back to this machine names the deployment's address.
  assert.throws(() => machines.remove({ id: machine.id }, 'admin'), (err) => err.code === 'inUse' && err.services.includes('embedding'));
  await assert.rejects(machines.update({ id: machine.id, address: '192.168.1.51' }, 'admin'), (err) => err.code === 'embeddingOnMachine');
  assert.throws(() => machines.assign({ service: 'embedding', machine: 'local' }, 'admin'), (err) => err.code === 'reindexRequired' && err.target.baseUrl === 'http://embed:8080/v1');
  embedding.baseUrl = 'http://embed:8080/v1';
  assert.equal(machines.assignmentOf('embedding').machine, 'local');
});

test('chat roles and vision move only with a model (#1840); OCR is set by the deployment', async () => {
  const { machines } = registry();
  const { machine } = await machines.add({ name: 'Pi 5', address: '192.168.1.50' }, 'admin');
  for (const service of ['chatFast', 'chatSmart', 'chatCode', 'chatCreative', 'vision']) assert.throws(() => machines.assign({ service, machine: machine.id, port: 8080 }, 'admin'), (err) => err.code === 'invalidModel');
  assert.throws(() => machines.assign({ service: 'ocr', machine: machine.id, port: 8080 }, 'admin'), (err) => err.code === 'setByDeployment');
  assert.throws(() => machines.assign({ service: 'nope', machine: 'local' }, 'admin'), (err) => err.code === 'unknownService');
  assert.throws(() => machines.assign({ service: 'decision', machine: 'm_missing', port: 1 }, 'admin'), (err) => err.status === 404);
  assert.throws(() => machines.assign({ service: 'decision', machine: machine.id, port: 70000 }, 'admin'), (err) => err.code === 'invalidPort');
});

test('persistence: saved in the settings store, read back on start; a damaged value keeps everything here', async () => {
  const store = memoryStore();
  const a = registry({ store });
  const { machine } = await a.machines.add({ name: 'Pi 5', address: '192.168.1.50' }, 'admin');
  a.machines.assign({ service: 'decision', machine: machine.id, port: 8040 }, 'admin');
  const b = registry({ store });
  assert.equal(b.machines.urlFor('decision'), 'http://192.168.1.50:8040');
  const damaged = registry({ store: memoryStore({ [KEY]: '{not json' }) });
  assert.equal(damaged.machines.urlFor('decision'), null);
  assert.deepEqual(damaged.machines.view().machines.map((m) => m.id), ['local']);
});

test('audit: add, update, remove and assign are each recorded with the actor', async () => {
  const { machines, audits } = registry();
  const { machine } = await machines.add({ name: 'Pi 5', address: '192.168.1.50' }, 'u-admin');
  await machines.update({ id: machine.id, name: 'Pi 5 (desk)', address: '192.168.1.60' }, 'u-admin');
  machines.assign({ service: 'decision', machine: machine.id, port: 8040 }, 'u-admin');
  assert.throws(() => machines.remove({ id: machine.id }, 'u-admin'), (err) => err.code === 'inUse');
  machines.assign({ service: 'decision', machine: 'local' }, 'u-admin');
  machines.remove({ id: machine.id }, 'u-admin');
  assert.deepEqual(audits.map((a) => a.action), ['machines.add', 'machines.update', 'machines.assign', 'machines.assign', 'machines.remove']);
  assert.ok(audits.every((a) => a.actor === 'u-admin'));
  assert.deepEqual(audits[1].detail, { id: machine.id, name: 'Pi 5 (desk)', address: 'http://192.168.1.60', moved: true, unresolved: false });
});

test('health: one probe per address at a time, cached for the TTL, failures read unreachable or down', async () => {
  let t = 0, calls = 0;
  const answers = { 'http://192.168.1.50:8040/health': 200, 'http://192.168.1.50:8080/health': 503 };
  const fetchImpl = async (url) => { calls++; await new Promise((r) => setImmediate(r)); if (!(url in answers)) throw Object.assign(Error('refused'), { code: 'ECONNREFUSED' }); return new Response('', { status: answers[url] }); };
  const health = createMachineHealth({ fetchImpl, decisionFetchImpl: fetchImpl, now: () => t, ttlMs: 30000 });
  const targets = [{ service: 'decision', url: 'http://192.168.1.50:8040', decision: true }, { service: 'reranker', url: 'http://192.168.1.50:8080' }, { service: 'embedding', url: 'http://192.168.1.99:8081/v1' }];
  const [a, b] = await Promise.all([health.check(targets), health.check(targets)]);
  assert.equal(calls, 3);
  assert.deepEqual([a.decision.state, a.reranker.state, a.reranker.reason, a.embedding.state], ['up', 'down', 'http-503', 'unreachable']);
  assert.deepEqual(a, b);
  t = 29000; await health.check(targets); assert.equal(calls, 3);
  t = 31000; await health.check(targets); assert.equal(calls, 6);
  assert.equal((await health.check([{ service: 'decision', url: null }])).decision.state, 'unknown');
  const refused = createMachineHealth({ fetchImpl: async () => { throw Object.assign(Error('refused'), { code: 'EPUBLICADDR' }); } });
  assert.equal((await refused.check([{ service: 'reranker', url: 'http://pi5.lan:8080' }])).reranker.reason, 'not-on-this-network');
  assert.equal(machineState([{ state: 'up' }, { state: 'unreachable' }]), 'unreachable');
  assert.equal(machineState([{ state: 'unknown' }]), 'idle');
});

function routeFixture() {
  const { machines, audits } = registry();
  const sent = [];
  const probes = [];
  const routes = createInferenceMachineRoutes({
    json: (res, status, body) => { sent.push({ status, body }); return true; },
    readJson: async (req) => req.body,
    machines,
    health: { check: async (targets) => { probes.push(targets); return Object.fromEntries(targets.map((x) => [x.service, { state: x.service === 'decision' ? 'unreachable' : 'unknown' }])); } },
    effective: { decision: () => 'http://laya:8040', embedding: () => null, reranker: () => null },
  });
  const call = (method, user, body, query = '') => routes({ method, body }, { setHeader() {} }, { path: '/api/models/machines', authn: user ? { user } : null, url: new URL(`http://x/api/models/machines${query}`) });
  return { call, sent, audits, probes, machines };
}
const ADMIN = { id: 'u-admin', role: 'admin' };
const MEMBER = { id: 'u-member', role: 'member' };

test('route: administrators only, on every method; other paths pass through', async () => {
  const f = routeFixture();
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
    await f.call(method, MEMBER, { action: 'add', name: 'x', address: '10.0.0.1' });
    assert.equal(f.sent.pop().status, 403, method);
    await f.call(method, null, { action: 'add', name: 'x', address: '10.0.0.1' });
    assert.equal(f.sent.pop().status, 401, method);
  }
  assert.equal(f.audits.length, 0);
  assert.equal(f.machines.view().machines.length, 1);
  const routes = createInferenceMachineRoutes({ json: () => true, readJson: async () => ({}), machines: f.machines, health: { check: async () => ({}) } });
  assert.equal(await routes({ method: 'GET' }, {}, { path: '/api/models/installed', authn: { user: ADMIN } }), false);
});

test('route: list, add (201), refuse a public address (400), re-index answer (409), health on request', async () => {
  const f = routeFixture();
  await f.call('GET', ADMIN);
  let r = f.sent.pop();
  assert.equal(r.status, 200);
  assert.equal(r.body.health, undefined);
  assert.equal(r.body.services.find((s) => s.id === 'decision').url, 'http://laya:8040');
  assert.equal(f.probes.length, 0);
  await f.call('POST', ADMIN, { action: 'add', name: 'Pi 5', address: '192.168.1.50' });
  r = f.sent.pop();
  assert.equal(r.status, 201);
  const id = r.body.machine.id;
  await f.call('POST', ADMIN, { action: 'add', name: 'Cloud', address: '93.184.216.34' });
  r = f.sent.pop();
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'publicAddress');
  await f.call('POST', ADMIN, { action: 'assign', service: 'embedding', machine: id, port: 8081 });
  r = f.sent.pop();
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'reindexRequired');
  assert.deepEqual(r.body.target, { baseUrl: 'http://192.168.1.50:8081/v1', model: 'embed-a', profile: 'nomic-v1' });
  await f.call('POST', ADMIN, { action: 'nope' });
  assert.equal(f.sent.pop().status, 400);
  await f.call('PUT', ADMIN, {});
  assert.equal(f.sent.pop().status, 405);
  await f.call('GET', ADMIN, undefined, '?health=1');
  r = f.sent.pop();
  assert.equal(r.body.health.services.decision.state, 'unreachable');
  assert.equal(r.body.health.machines.local, 'unreachable');
  assert.equal(r.body.health.machines[id], 'idle');
  assert.deepEqual(f.audits.map((a) => a.action), ['machines.add']);
});
