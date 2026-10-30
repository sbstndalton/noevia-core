'use strict';
// #2191 round 3: DELETE /api/projects/{id}/files is the Rust front's (noevia-rs crates/server-projects
// files.rs, tested there through real HTTP against a synthetic WebDAV: Node's order, status codes and
// bodies, ownsFile, the storage failures, the prune and the queued RAG removal). Node refuses it before
// authentication, runs the `unindex` job the front queues, and its handler is gone.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const test = require('node:test');
const { OWNED_ROUTES, ROUTE_REFUSAL, owned, refuseOwned } = require('./rust-project-files.cjs');

const parseRequestUrl = (req, base = 'http://localhost') => { try { return new URL(req.url, base); } catch { return null; } };
const json = (res, status, body) => Object.assign(res, { status, body });

test('the owned list is exactly the file delete', () => {
  assert.deepEqual([...OWNED_ROUTES], ['DELETE /api/projects/{id}/files']);
  assert.ok(Object.isFrozen(OWNED_ROUTES));
  assert.equal(ROUTE_REFUSAL.code, 'RUST_PROJECT_FILES_OWNED');
  assert.equal(owned('DELETE', '/api/projects/p1/files'), true);
  assert.equal(owned('DELETE', '/api/projects/p%2F1/files'), true);
  for (const m of ['GET', 'PUT', 'PATCH', 'POST', 'HEAD']) assert.equal(owned(m, '/api/projects/p1/files'), false, m);
  for (const p of ['/api/projects//files', '/api/projects/p1/files/', '/api/projects/p1/files/x', '/api/projects/a/b/files']) assert.equal(owned('DELETE', p), false, p);
});

test('an owned request is refused with a 503 before its body is read; the rest falls through', () => {
  for (const url of ['/api/projects/p1/files', '/api/projects/p1/files?x=1']) {
    const req = { url, method: 'DELETE', headers: { host: 'localhost' }, on() { throw new Error('body listener'); } };
    const res = {};
    assert.equal(refuseOwned(req, res, { parseRequestUrl, json }), true, url);
    assert.deepEqual(res, { status: 503, body: ROUTE_REFUSAL });
  }
  for (const [method, url] of [['POST', '/api/projects/p1/files'], ['DELETE', '/api/projects/p1'], ['DELETE', '/api/projects/p1/assets/a']]) {
    assert.equal(refuseOwned({ url, method, headers: {} }, {}, { parseRequestUrl, json }), false, `${method} ${url}`);
  }
  assert.equal(refuseOwned({ url: '//[', method: 'DELETE', headers: {} }, {}, { parseRequestUrl, json }), false);
});

test('the dead Node handler is gone; this process runs the unindex jobs', () => {
  const routes = fs.readFileSync(path.join(__dirname, 'routes', 'projects.cjs'), 'utf8');
  assert.equal(routes.includes('projFileDel'), false);
  assert.ok(require('./rust-project-storage.cjs').CORE_KINDS.includes('unindex'));
  const index = fs.readFileSync(path.join(__dirname, 'index.cjs'), 'utf8');
  assert.ok(index.includes("job.kind === 'unindex'") && index.includes('rag.deleteProjectFile(job.project, job.file, userId)'));
});

// ── through the real router ─────────────────────────────────────────────────────

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-rust-project-files-'));
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

test('through the router: the file delete is refused signed out and signed in', async () => {
  const admin = seedAccount(dataDir, { username: 'files-admin', displayName: 'Synthetic', role: 'admin', publicOrigin: 'http://localhost' });
  const as = (a) => ({ cookie: a.cookie, origin: 'http://localhost', 'x-csrf-token': a.csrf, 'content-type': 'application/json' });
  for (const headers of [{}, as(admin)]) {
    const r = await request('/api/projects/p1/files', { method: 'DELETE', headers, body: { path: 'x/y.md' } });
    assert.deepEqual([r.status, r.json], [503, ROUTE_REFUSAL]);
  }
  // Positive control: the config route is still Node's.
  assert.equal((await request('/api/projects/p1/config', { method: 'POST', headers: as(admin), body: {} })).status, 404);
});
