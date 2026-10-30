'use strict';
// #2191 round 4: GET /api/projects/{id}/documents/pages is the Rust front's (noevia-rs crates/server-projects
// document_pages.rs, tested there through real HTTP against answers this process gave on the same synthetic
// stored results). Node refuses the GET before authentication and its handler is gone; the chat tool's page
// read (toolboxes.cjs, document-sources.cjs readPages) stays here.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const test = require('node:test');
const { OWNED_ROUTES, ROUTE_REFUSAL, owned, refuseOwned } = require('./rust-project-document-pages.cjs');

const parseRequestUrl = (req, base = 'http://localhost') => { try { return new URL(req.url, base); } catch { return null; } };
const json = (res, status, body) => Object.assign(res, { status, body });

test('the owned list is exactly the page reader', () => {
  assert.deepEqual([...OWNED_ROUTES], ['GET /api/projects/{id}/documents/pages']);
  assert.ok(Object.isFrozen(OWNED_ROUTES));
  assert.equal(ROUTE_REFUSAL.code, 'RUST_PROJECT_DOCUMENT_PAGES_OWNED');
  assert.equal(owned('GET', '/api/projects/p1/documents/pages'), true);
  assert.equal(owned('GET', '/api/projects/p%2F1/documents/pages'), true);
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']) assert.equal(owned(m, '/api/projects/p1/documents/pages'), false, m);
  for (const p of ['/api/projects//documents/pages', '/api/projects/p1/documents/pages/', '/api/projects/p1/documents', '/api/projects/a/b/documents/pages']) assert.equal(owned('GET', p), false, p);
});

test('an owned request is refused with a 503; the rest falls through', () => {
  for (const url of ['/api/projects/p1/documents/pages', '/api/projects/p1/documents/pages?name=a.pdf&startPage=2']) {
    const res = {};
    assert.equal(refuseOwned({ url, method: 'GET', headers: { host: 'localhost' } }, res, { parseRequestUrl, json }), true, url);
    assert.deepEqual(res, { status: 503, body: ROUTE_REFUSAL });
  }
  for (const [method, url] of [['POST', '/api/projects/p1/documents/pages'], ['POST', '/api/projects/p1/documents'], ['GET', '/api/projects/p1/documents/original']]) {
    assert.equal(refuseOwned({ url, method, headers: {} }, {}, { parseRequestUrl, json }), false, `${method} ${url}`);
  }
  assert.equal(refuseOwned({ url: '//[', method: 'GET', headers: {} }, {}, { parseRequestUrl, json }), false);
});

test('the dead Node handler is gone; the chat tool keeps its page read', () => {
  const routes = ''; assert.equal(fs.existsSync(path.join(__dirname, 'routes', 'projects.cjs')), false, 'no project route file is left (#2191 round 9)');
  assert.equal(routes.includes('docRead'), false);
  assert.equal(routes.includes('documentSources.readPages'), false);
  assert.equal(typeof require('./document-sources.cjs').readPages, 'function');
  assert.ok(fs.readFileSync(path.join(__dirname, 'toolboxes.cjs'), 'utf8').includes('documentSources.readPages('));
});

// ── through the real router ─────────────────────────────────────────────────────

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-rust-project-document-pages-'));
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

test('through the router: the page reader is refused signed out and signed in', async () => {
  const admin = seedAccount(dataDir, { username: 'pages-admin', displayName: 'Synthetic', role: 'admin', publicOrigin: 'http://localhost' });
  const as = (a) => ({ cookie: a.cookie, origin: 'http://localhost', 'x-csrf-token': a.csrf, 'content-type': 'application/json' });
  for (const headers of [{}, as(admin)]) {
    const r = await request('/api/projects/p1/documents/pages?name=a.pdf', { headers });
    assert.deepEqual([r.status, r.json], [503, ROUTE_REFUSAL]);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
  }
  // Positive control: the browser route (chat-bound) is still Node's (no such project; the config is the front's since round 9); the document upload is the
  // front's since round 5 (rust-project-documents.test.cjs).
  assert.equal((await request('/api/projects/p1/browser', { method: 'POST', headers: as(admin), body: {} })).status, 404);
});
