'use strict';
// #2191 round 5: POST /api/projects/{id}/documents is the Rust front's (noevia-rs crates/server-projects
// project_documents.rs on the Docling pipeline and its durable extraction queue, tested there through
// real HTTP against synthetic Docling and OCR sidecars: Docling down -> queued -> recovered). Node refuses
// the POST before authentication, with or without ?background=1, and its handler is gone; uploads
// (/upload), the folder sync and folder imports still extract here.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const test = require('node:test');
const { OWNED_ROUTES, ROUTE_REFUSAL, owned, refuseOwned } = require('./rust-project-documents.cjs');

const parseRequestUrl = (req, base = 'http://localhost') => { try { return new URL(req.url, base); } catch { return null; } };
const json = (res, status, body) => Object.assign(res, { status, body });

test('the owned list is exactly the document upload', () => {
  assert.deepEqual([...OWNED_ROUTES], ['POST /api/projects/{id}/documents']);
  assert.ok(Object.isFrozen(OWNED_ROUTES));
  assert.equal(ROUTE_REFUSAL.code, 'RUST_PROJECT_DOCUMENTS_OWNED');
  assert.equal(owned('POST', '/api/projects/p1/documents'), true);
  assert.equal(owned('POST', '/api/projects/p%2F1/documents'), true);
  for (const m of ['GET', 'PUT', 'PATCH', 'DELETE', 'HEAD']) assert.equal(owned(m, '/api/projects/p1/documents'), false, m);
  for (const p of ['/api/projects//documents', '/api/projects/p1/documents/', '/api/projects/p1/documents/pages', '/api/projects/a/b/documents', '/api/projects/p1/upload']) assert.equal(owned('POST', p), false, p);
});

test('an owned request is refused with a 503 before its body is read; the rest falls through', () => {
  for (const url of ['/api/projects/p1/documents', '/api/projects/p1/documents?background=1']) {
    const res = {};
    const req = { url, method: 'POST', headers: { host: 'localhost' }, on() { throw new Error('body listener'); } };
    assert.equal(refuseOwned(req, res, { parseRequestUrl, json }), true, url);
    assert.deepEqual(res, { status: 503, body: ROUTE_REFUSAL });
  }
  for (const [method, url] of [['GET', '/api/projects/p1/documents/pages'], ['POST', '/api/projects/p1/upload'], ['POST', '/api/projects/p1/sources/sync'], ['GET', '/api/projects/p1/documents']]) {
    assert.equal(refuseOwned({ url, method, headers: {} }, {}, { parseRequestUrl, json }), false, `${method} ${url}`);
  }
  assert.equal(refuseOwned({ url: '//[', method: 'POST', headers: {} }, {}, { parseRequestUrl, json }), false);
});

test('the dead Node handler is gone; the uploads and the sync keep their extraction', () => {
  const routes = fs.readFileSync(path.join(__dirname, 'routes', 'projects.cjs'), 'utf8');
  assert.equal(routes.includes('projDocs'), false);
  assert.equal(routes.includes('upload|documents|sources'), false, 'no background wrapper for the documents path');
  assert.ok(routes.includes('documentSources.ingest('), 'the /upload and sync paths still ingest here');
  assert.equal(typeof require('./documents.cjs').extractDocumentText, 'function');
});

// ── through the real router ─────────────────────────────────────────────────────

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-rust-project-documents-'));
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

test('through the router: the document upload is refused signed out and signed in, nothing written', async () => {
  const admin = seedAccount(dataDir, { username: 'documents-admin', displayName: 'Synthetic', role: 'admin', publicOrigin: 'http://localhost' });
  const as = (a) => ({ cookie: a.cookie, origin: 'http://localhost', 'x-csrf-token': a.csrf, 'content-type': 'application/json' });
  const body = { name: 'synthetic.pdf', dataBase64: Buffer.from('%PDF-1.4 synthetic').toString('base64') };
  for (const headers of [{}, as(admin)]) {
    for (const url of ['/api/projects/p1/documents', '/api/projects/p1/documents?background=1']) {
      const r = await request(url, { method: 'POST', headers, body });
      assert.deepEqual([r.status, r.json], [503, ROUTE_REFUSAL], url);
      assert.equal(r.headers['x-content-type-options'], 'nosniff');
    }
  }
  const users = path.join(dataDir, 'users');
  const documents = fs.existsSync(users) ? fs.readdirSync(users).filter((u) => fs.existsSync(path.join(users, u, 'project-documents'))) : [];
  assert.deepEqual(documents, [], 'no original or result was written');
  // Positive control: the file upload is still Node's (no such project).
  assert.equal((await request('/api/projects/p1/upload', { method: 'POST', headers: as(admin), body: {} })).status, 404);
});
