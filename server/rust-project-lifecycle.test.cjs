'use strict';
// #2191 round 2: POST /api/projects and DELETE /api/projects/{projectId} are the Rust front's
// (noevia-rs crates/server-projects lifecycle.rs, tested there through real HTTP: auth, CSRF, tenant
// scope, Node's status codes and bodies, the purge). Node refuses both before authentication, publishes
// the toolbox catalogue the front's create reads, and its handlers are gone.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const test = require('node:test');
const { OWNED_ROUTES, ROUTE_REFUSAL, owned, refuseOwned } = require('./rust-project-lifecycle.cjs');

const parseRequestUrl = (req, base = 'http://localhost') => { try { return new URL(req.url, base); } catch { return null; } };
const json = (res, status, body) => Object.assign(res, { status, body });

test('the owned list is exactly the create and the delete', () => {
  assert.deepEqual([...OWNED_ROUTES], ['POST /api/projects', 'DELETE /api/projects/{projectId}']);
  assert.ok(Object.isFrozen(OWNED_ROUTES));
  assert.equal(ROUTE_REFUSAL.code, 'RUST_PROJECT_LIFECYCLE_OWNED');
  assert.equal(owned('POST', '/api/projects'), true);
  assert.equal(owned('DELETE', '/api/projects/p1'), true);
  assert.equal(owned('DELETE', '/api/projects/p%2F1'), true);
  for (const m of ['GET', 'PUT', 'PATCH', 'DELETE', 'HEAD']) assert.equal(owned(m, '/api/projects'), false, m);
  for (const m of ['GET', 'PUT', 'PATCH', 'POST', 'HEAD']) assert.equal(owned(m, '/api/projects/p1'), false, m);
});

test('an owned request is refused with a 503 before its body is read; the rest falls through', () => {
  for (const [method, url] of [['POST', '/api/projects'], ['POST', '/api/projects?x=1'], ['DELETE', '/api/projects/p1']]) {
    const req = { url, method, headers: { host: 'localhost' }, on() { throw new Error('body listener'); } };
    const res = {};
    assert.equal(refuseOwned(req, res, { parseRequestUrl, json }), true, url);
    assert.deepEqual(res, { status: 503, body: ROUTE_REFUSAL });
  }
  for (const [method, url] of [
    ['POST', '/api/projects/'], ['POST', '/api/projects/p1/config'], ['DELETE', '/api/projects/p1/files'], ['DELETE', '/api/projects/'],
    ['DELETE', '/api/projects/p1/chats/c1'], ['POST', '/API/PROJECTS'], ['DELETE', '/api/projects//'], ['POST', '/api/import/conversations'],
  ]) assert.equal(refuseOwned({ url, method, headers: {} }, {}, { parseRequestUrl, json }), false, `${method} ${url}`);
  assert.equal(refuseOwned({ url: '//[', method: 'POST', headers: {} }, {}, { parseRequestUrl, json }), false);
});

test('the dead Node handlers are gone; the store keeps createProject and deleteProject for its other callers', () => {
  const routes = fs.readFileSync(path.join(__dirname, 'routes', 'projects.cjs'), 'utf8');
  assert.equal(routes.includes("p === '/api/projects' && req.method === 'POST'"), false);
  assert.equal(routes.includes("projMatch && req.method === 'DELETE'"), false);
  const store = fs.readFileSync(path.join(__dirname, 'projects.cjs'), 'utf8');
  assert.ok(store.includes('async function createProject(') && store.includes('function deleteProject('));
});

// ── through the real router ─────────────────────────────────────────────────────

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-rust-project-lifecycle-'));
process.env.UI_DATA_DIR = dataDir;
require('../tests/server/project-store-server.cjs').installProjectStore(dataDir);
process.env.PUBLIC_ORIGIN = 'http://localhost';
process.env.LEGACY_AUTH_COMPAT = 'false';
const originalWarn = console.warn;
console.warn = () => {};
const { handleRequest } = require('./index.cjs');
console.warn = originalWarn;
const { seedAccount } = require('../tests/server/seed-account.cjs');

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

async function request(url, { method = 'GET', headers = {}, body } = {}) {
  const payload = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  const req = Readable.from(payload ? [payload] : []);
  Object.assign(req, { url, method, headers: { host: 'localhost', ...headers }, socket: { remoteAddress: '127.0.0.1' } });
  const chunks = [];
  const out = {};
  const res = new Writable({ write(chunk, _e, cb) { chunks.push(Buffer.from(chunk)); cb(); } });
  res.statusCode = 200;
  res.headersSent = false;
  res.setHeader = (k, v) => { out[k.toLowerCase()] = v; };
  res.writeHead = (status, h = {}) => { res.statusCode = status; res.headersSent = true; for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v; return res; };
  const done = new Promise((resolve, reject) => { res.once('finish', resolve); res.once('error', reject); });
  await handleRequest(req, res);
  await done;
  const text = Buffer.concat(chunks).toString('utf8');
  let parsed = null; try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.statusCode, headers: out, text, json: parsed };
}

test('through the router: create and delete are refused signed out and signed in; the catalogue is published', async () => {
  const admin = seedAccount(dataDir, { username: 'lifecycle-admin', displayName: 'Synthetic', role: 'admin', publicOrigin: 'http://localhost' });
  const as = (a) => ({ cookie: a.cookie, origin: 'http://localhost', 'x-csrf-token': a.csrf, 'content-type': 'application/json' });
  for (const [method, url] of [['POST', '/api/projects'], ['DELETE', '/api/projects/p1']]) {
    for (const headers of [{}, as(admin)]) {
      const r = await request(url, { method, headers, body: method === 'POST' ? { name: 'Synthetic' } : undefined });
      assert.deepEqual([r.status, r.json], [503, ROUTE_REFUSAL], `${method} ${url}`);
      assert.equal(r.headers['x-content-type-options'], 'nosniff');
    }
  }
  assert.equal(fs.existsSync(path.join(dataDir, 'users', admin.id, 'projects.json')), false, 'nothing created');
  // Each request start publishes what a create needs (only when it changed).
  const catalogue = JSON.parse(fs.readFileSync(path.join(dataDir, 'project-catalogue.json'), 'utf8'));
  assert.equal(catalogue.version, 1);
  assert.deepEqual(catalogue.defaults, ['core']);
  assert.ok(catalogue.selectable.includes('core'));
  assert.ok(!catalogue.selectable.includes('gdrive'), 'connector boxes are not selectable');
  assert.deepEqual(catalogue.icons, Object.keys(require('../contracts/project-icons.json')));
  // Positive control: the config route is still Node's.
  assert.equal((await request('/api/projects/p1/config', { method: 'POST', headers: as(admin), body: {} })).status, 404);
});
