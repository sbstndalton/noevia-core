'use strict';
// sbstndalton/noevia#2190 close-out: GET /api/auto-roles is the Rust front's (noevia-rs
// bins/noevia-server auto_roles_routes.rs, tested there through real HTTP). Node refuses the GET before
// authentication, still owns the PUT (a save warms the roles in the engine) and the file the front
// reads, and publishes what only it knows (the served catalogue, the roles on other machines and their
// models) as auto-roles-snapshot.json.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const test = require('node:test');
const roles = require('./rust-auto-roles.cjs');

const parseRequestUrl = (req, base = 'http://localhost') => { try { return new URL(req.url, base); } catch { return null; } };
const json = (res, status, body) => Object.assign(res, { status, body });
const refuse = (method, url) => { const res = {}; return roles.refuseOwned({ url, method, headers: {}, on() { throw new Error('body listener'); } }, res, { parseRequestUrl, json }) ? res : null; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('exactly the GET of the exact path is refused, before authentication; the PUT is Node\'s', () => {
  assert.equal(roles.ROUTE_REFUSAL.code, 'RUST_AUTO_ROLES_OWNED');
  assert.deepEqual(refuse('GET', '/api/auto-roles'), { status: 503, body: roles.ROUTE_REFUSAL });
  assert.deepEqual(refuse('GET', '/api/auto-roles?x=1'), { status: 503, body: roles.ROUTE_REFUSAL });
  for (const [m, u] of [['PUT', '/api/auto-roles'], ['POST', '/api/auto-roles'], ['DELETE', '/api/auto-roles'], ['HEAD', '/api/auto-roles'], ['GET', '/api/auto-roles/'], ['GET', '/api/auto-roles-x']]) {
    assert.equal(refuse(m, u), null, `${m} ${u}`);
  }
});

const served = (...names) => names.map((name) => ({ name, missingFile: false, status: 'loaded', labels: ['chat'] }));

test('the catalogue is published as names and missingFile only; an unreadable engine is null', async () => {
  const state = await roles.autoRolesState({
    servedCatalogue: async () => [...served('a', 'b'), { name: 'gone', missingFile: true }, { name: 7 }, null, { missingFile: true }],
    remoteRoles: () => ({}), machineModels: () => [],
  });
  assert.deepEqual(state, { catalogue: [{ name: 'a', missingFile: false }, { name: 'b', missingFile: false }, { name: 'gone', missingFile: true }], machineRoles: [], machineModels: [] });
  const unknown = await roles.autoRolesState({ servedCatalogue: async () => null, remoteRoles: () => ({}), machineModels: () => [] });
  assert.deepEqual(unknown, { catalogue: null, machineRoles: [], machineModels: [] });
});

test('roles on other machines are named, and a machine model this catalogue lists is left out of the list (#1855)', async () => {
  const rows = [
    { model: 'remote-only', machine: { id: 'm1', name: 'Box' }, roles: ['fast'] },
    { model: 'also-here', machine: { id: 'm2', name: 'Other' }, roles: ['vision'] },
    { model: 'ghost', machine: { id: 'm3', name: 'Third' }, roles: ['code'] },
  ];
  const state = await roles.autoRolesState({
    servedCatalogue: async () => [...served('also-here'), { name: 'ghost', missingFile: true }],
    remoteRoles: () => ({ fast: {}, vision: {}, code: {} }), machineModels: () => rows,
  });
  assert.deepEqual(state.machineRoles, ['fast', 'vision', 'code']);
  // `ghost` is listed by the catalogue (its file is missing) so it is answered here too: core filtered on every name.
  assert.deepEqual(state.machineModels, [rows[0]]);
  // With no catalogue nothing is filtered (core: `new Set([])`).
  const none = await roles.autoRolesState({ servedCatalogue: async () => null, remoteRoles: () => ({ fast: {} }), machineModels: () => rows });
  assert.deepEqual(none.machineModels, rows);
  // Machines that cannot be read are none, not a failure of the publish.
  const broken = await roles.autoRolesState({ servedCatalogue: async () => served('a'), remoteRoles: () => { throw new Error('x'); }, machineModels: () => { throw new Error('y'); } });
  assert.deepEqual({ r: broken.machineRoles, m: broken.machineModels }, { r: [], m: [] });
});

test('the publisher writes auto-roles-snapshot.json, and a model write republishes at once', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-autoroles-snap-'));
  test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let names = ['a'];
  const p = roles.createAutoRolesPublisher({ dataDir, servedCatalogue: async () => served(...names), remoteRoles: () => ({}), machineModels: () => [], env: { AUTO_ROLES_PUBLISH_MS: '4000' } });
  assert.equal(p.everyMs, 4000);
  assert.equal(p.file, path.join(dataDir, 'auto-roles-snapshot.json'));
  await p.publish();
  const doc = JSON.parse(fs.readFileSync(p.file, 'utf8'));
  assert.equal(doc.version, 1);
  assert.equal(doc.kind, 'auto-roles');
  assert.equal(doc.everyMs, 4000);
  assert.deepEqual(doc.catalogue, [{ name: 'a', missingFile: false }]);
  assert.equal(fs.statSync(p.file).mode & 0o777, 0o600);
  assert.equal(roles.createAutoRolesPublisher({ dataDir, servedCatalogue: async () => null, remoteRoles: () => ({}), machineModels: () => [], env: {} }).everyMs, 15000);
  const service = { invalidateModelReads() { return 'dropped'; } };
  p.watch(service);
  names = ['a', 'b'];
  assert.equal(service.invalidateModelReads(), 'dropped');
  await wait(250);
  assert.deepEqual(JSON.parse(fs.readFileSync(p.file, 'utf8')).catalogue.map((m) => m.name), ['a', 'b']);
  p.watch(null);
  p.watch({});
});

test('the PUT is still Node\'s: it validates against the catalogue and saves the file the front reads', () => {
  const source = fs.readFileSync(path.join(__dirname, 'routes', 'models.cjs'), 'utf8');
  assert.ok(source.includes("if (req.method === 'PUT') {\n        const raw = await readBody(req);"));
  assert.ok(source.includes('ensureRolesLoaded()'));
  assert.ok(source.includes("if (req.method === 'GET') return json(res, 503, AUTO_ROLES_REFUSAL);"));
});

// ── through the real router ─────────────────────────────────────────────────────

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-rust-autoroles-'));
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

test('through the router: the GET is refused whoever asks; the PUT still reaches Node\'s handler', async () => {
  const admin = seedAccount(dataDir, { username: 'autoroles-admin', displayName: 'Synthetic', role: 'admin', publicOrigin: 'http://localhost' });
  for (const headers of [{}, { cookie: admin.cookie }]) {
    const r = await request('/api/auto-roles', { headers });
    assert.equal(r.status, 503);
    assert.deepEqual(r.json, roles.ROUTE_REFUSAL);
  }
  // The PUT is not refused: it reaches the handler (a body it cannot parse is that handler's own 400).
  const put = await request('/api/auto-roles', { method: 'PUT', headers: { cookie: admin.cookie, origin: 'http://localhost', 'x-csrf-token': admin.csrf } });
  assert.equal(put.status, 400);
  assert.equal((await request('/api/auto-roles', { method: 'PUT' })).status, 401, 'signed out is the gate\'s');
});

test('the catalogue is read only while a signed-in page has asked: an idle installation reads no engines (#2190 review M1)', async () => {
  const { createDemand, DEMAND_FILE } = require('./published-snapshot.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-autoroles-demand-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let reads = 0;
  const demand = createDemand({ dir, windowMs: 400, pollMs: 30 });
  const p = roles.createAutoRolesPublisher({ dataDir: dir, servedCatalogue: async () => { reads += 1; return served('a'); }, remoteRoles: () => ({}), machineModels: () => [], demand, env: { AUTO_ROLES_PUBLISH_MS: '1000' } });
  const service = { invalidateModelReads() {} };
  p.watch(service);
  p.start();
  demand.start();
  await wait(200);
  service.invalidateModelReads();
  await wait(150);
  assert.equal(reads, 0, 'nobody asked: the engines are not read, not even after a model write');
  assert.equal(fs.existsSync(p.file), false);
  fs.writeFileSync(path.join(dir, DEMAND_FILE), String(Date.now()), { mode: 0o600 });
  await wait(250);
  assert.ok(reads >= 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(p.file, 'utf8')).catalogue, [{ name: 'a', missingFile: false }]);
  await wait(700);
  const seen = reads;
  await wait(300);
  assert.equal(reads, seen, 'idle again: no more reads');
  p.stop();
  demand.stop();
});
