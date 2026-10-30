'use strict';
// sbstndalton/noevia#2190 close-out: GET /api/health is the Rust front's (noevia-rs
// bins/noevia-server health_routes.rs, tested there through real HTTP). Node refuses the GET before
// authentication and publishes what only it knows, the retrieval state, as rag-status.json.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const test = require('node:test');
const health = require('./rust-health.cjs');

const parseRequestUrl = (req, base = 'http://localhost') => { try { return new URL(req.url, base); } catch { return null; } };
const json = (res, status, body) => Object.assign(res, { status, body });
const refuse = (method, url) => { const res = {}; return health.refuseOwned({ url, method, headers: {}, on() { throw new Error('body listener'); } }, res, { parseRequestUrl, json }) ? res : null; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('exactly the GET of the exact path is refused, before authentication', () => {
  assert.equal(health.ROUTE_REFUSAL.code, 'RUST_HEALTH_OWNED');
  assert.deepEqual(refuse('GET', '/api/health'), { status: 503, body: health.ROUTE_REFUSAL });
  assert.deepEqual(refuse('GET', '/api/health?probe=1'), { status: 503, body: health.ROUTE_REFUSAL });
  for (const [m, u] of [['POST', '/api/health'], ['PUT', '/api/health'], ['HEAD', '/api/health'], ['GET', '/api/health/'], ['GET', '/api/healthz'], ['GET', '/api/ready'], ['GET', '/api/health/x']]) {
    assert.equal(refuse(m, u), null, `${m} ${u}`);
  }
});

test('the state is ragAvailable and one of the four words; anything else, or a probe that throws, is unavailable', async () => {
  const state = (rag, word) => health.ragState({ ragAvailable: () => rag, retrievalStatus: async () => word });
  for (const word of health.WORDS) assert.deepEqual(await state(true, word), { ragAvailable: true, retrieval: word });
  assert.deepEqual(health.WORDS, ['available', 'degraded', 'off', 'unavailable']);
  assert.deepEqual(await state(false, 'unavailable'), { ragAvailable: false, retrieval: 'unavailable' });
  for (const odd of ['Available', '', undefined, null, 5, {}]) assert.deepEqual(await state(true, odd), { ragAvailable: true, retrieval: 'unavailable' }, String(odd));
  assert.deepEqual(await health.ragState({ ragAvailable: () => 1, retrievalStatus: async () => { throw new Error('x'); } }), { ragAvailable: true, retrieval: 'unavailable' });
});

test('the publisher writes rag-status.json with the state, the interval and the header the front checks', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-ragstatus-'));
  test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let word = 'degraded';
  const p = health.createRagStatusPublisher({ dataDir, rag: { ragAvailable: () => true, retrievalStatus: async () => word }, env: { RAG_STATUS_PUBLISH_MS: '2500' } });
  assert.equal(p.everyMs, 2500);
  assert.equal(p.file, path.join(dataDir, 'rag-status.json'));
  const before = Date.now();
  await p.publish();
  const doc = JSON.parse(fs.readFileSync(p.file, 'utf8'));
  assert.deepEqual({ ...doc, writtenAt: undefined }, { version: 1, kind: 'rag-status', writtenAt: undefined, everyMs: 2500, ragAvailable: true, retrieval: 'degraded' });
  assert.ok(doc.writtenAt >= before && doc.writtenAt <= Date.now());
  assert.equal(fs.statSync(p.file).mode & 0o777, 0o600);
  word = 'off';
  await p.publish();
  assert.equal(JSON.parse(fs.readFileSync(p.file, 'utf8')).retrieval, 'off');
  assert.equal(health.createRagStatusPublisher({ dataDir, rag: { ragAvailable: () => true, retrievalStatus: async () => 'available' }, env: {} }).everyMs, 10000);
});

test("an administrator's embedding change shows at once: the service's refresh republishes", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-ragstatus-'));
  test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let word = 'available';
  const p = health.createRagStatusPublisher({ dataDir, rag: { ragAvailable: () => true, retrievalStatus: async () => word }, env: {} });
  const service = { async refresh() { return 'refreshed'; } };
  p.watch(service);
  word = 'off';
  assert.equal(await service.refresh(), 'refreshed', 'the wrapped call returns the service\'s own result');
  await wait(250);
  assert.equal(JSON.parse(fs.readFileSync(p.file, 'utf8')).retrieval, 'off');
  p.watch(null);
  p.watch({});
});

// ── through the real router ─────────────────────────────────────────────────────

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-rust-health-'));
process.env.UI_DATA_DIR = dataDir;
require('../tests/server/project-store-server.cjs').installProjectStore(dataDir);
process.env.PUBLIC_ORIGIN = 'http://localhost';
process.env.LEGACY_AUTH_COMPAT = 'false';
const originalWarn = console.warn;
console.warn = () => {};
const index = require('./index.cjs');
console.warn = originalWarn;
const { seedAccount } = require('../tests/server/seed-account.cjs');
test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

async function request(url, { method = 'GET', headers = {} } = {}) {
  const req = Readable.from([]);
  Object.assign(req, { url, method, headers: { host: 'localhost', ...headers }, socket: { remoteAddress: '127.0.0.1' } });
  const chunks = [];
  const out = {};
  const res = new Writable({ write(chunk, _e, cb) { chunks.push(Buffer.from(chunk)); cb(); } });
  res.statusCode = 200;
  res.headersSent = false;
  res.setHeader = (k, v) => { out[k.toLowerCase()] = v; };
  res.writeHead = (status, h = {}) => { res.statusCode = status; res.headersSent = true; for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v; return res; };
  const done = new Promise((resolve, reject) => { res.once('finish', resolve); res.once('error', reject); });
  await index.handleRequest(req, res);
  await done;
  const text = Buffer.concat(chunks).toString('utf8');
  let parsed = null; try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.statusCode, headers: out, text, json: parsed };
}

test('through the router: the GET is refused whoever asks, and no other method finds a route', async () => {
  const admin = seedAccount(dataDir, { username: 'health-admin', displayName: 'Synthetic', role: 'admin', publicOrigin: 'http://localhost' });
  for (const headers of [{}, { cookie: admin.cookie }]) {
    const r = await request('/api/health', { headers });
    assert.equal(r.status, 503);
    assert.deepEqual(r.json, health.ROUTE_REFUSAL);
  }
  // Signed in, another method has no route in Node any more (it answered every method before).
  const post = await request('/api/health', { method: 'POST', headers: { cookie: admin.cookie, origin: 'http://localhost', 'x-csrf-token': admin.csrf } });
  assert.equal(post.status, 404);
  assert.equal((await request('/api/health', { method: 'POST' })).status, 401, 'signed out is the gate\'s');
  // /api/ready is still Node-answered and unauthenticated.
  assert.equal((await request('/api/ready')).status, 200);
});

test('retrieval is probed only while a signed-in page has asked: an idle installation runs no embeddings probe (#2190 review M1)', async () => {
  const { createDemand, DEMAND_FILE } = require('./published-snapshot.cjs');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-health-demand-'));
  test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let probes = 0;
  const rag = { ragAvailable: () => true, retrievalStatus: async () => { probes += 1; return 'available'; } };
  const demand = createDemand({ dir: dataDir, windowMs: 400, pollMs: 30 });
  const p = health.createRagStatusPublisher({ dataDir, rag, demand, env: { RAG_STATUS_PUBLISH_MS: '1000' } });
  const marker = path.join(dataDir, DEMAND_FILE);
  p.start();
  demand.start();
  await wait(200);
  assert.equal(probes, 0, 'nobody asked: not one probe');
  assert.equal(fs.existsSync(p.file), false);
  p.changed();
  await wait(150);
  assert.equal(probes, 0, 'a change nobody will read is not published');
  // The front touches the marker (a rename of a new file, as it does): the first snapshot comes at once.
  fs.writeFileSync(`${marker}.1.tmp`, String(Date.now()), { mode: 0o600 });
  fs.renameSync(`${marker}.1.tmp`, marker);
  await wait(250);
  assert.ok(probes >= 1, 'asked: probed');
  assert.equal(JSON.parse(fs.readFileSync(p.file, 'utf8')).retrieval, 'available');
  // Nobody asks any more: the probes stop.
  await wait(700);
  const seen = probes;
  await wait(300);
  assert.equal(probes, seen, 'idle again: no more probes');
  p.stop();
  demand.stop();
});
