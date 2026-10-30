'use strict';
// #2191: GET /api/projects/{id}/sources/text, .../documents/original and .../uploads/original are
// the Rust front's (noevia-rs crates/server-projects sources.rs and originals.rs, tested there
// through real HTTP: owner-only scope, Node's status codes and headers, symlink refusals). Node
// refuses those GETs before authentication; every other method, the page reader and every other
// path shape still runs Node's ordinary chain.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const test = require('node:test');
const { OWNED_ROUTES, ROUTE_REFUSAL, owned, refuseOwned } = require('./rust-project-reads.cjs');

const parseRequestUrl = (req, base = 'http://localhost') => { try { return new URL(req.url, base); } catch { return null; } };
const json = (res, status, body) => Object.assign(res, { status, body });

test('the owned list is exactly the three source reads, GET only', () => {
  assert.deepEqual([...OWNED_ROUTES], ['GET /api/projects/{id}/sources/text', 'GET /api/projects/{id}/documents/original', 'GET /api/projects/{id}/{*}/original']);
  assert.ok(Object.isFrozen(OWNED_ROUTES));
  assert.equal(ROUTE_REFUSAL.code, 'RUST_PROJECT_READS_OWNED');
  for (const p of ['/api/projects/p1/sources/text', '/api/projects/p1/documents/original', '/api/projects/p%2F1/uploads/original']) {
    assert.equal(owned('GET', p), true, p);
    for (const m of ['HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']) assert.equal(owned(m, p), false, `${m} ${p}`);
  }
});

test('an owned GET is refused with a 503 and its code, before the body is touched', () => {
  for (const url of ['/api/projects/p1/sources/text?name=a.md', '/api/projects/p1/documents/original?name=x.pdf', '/api/projects/p1/uploads/original']) {
    const req = { url, method: 'GET', headers: { host: 'localhost' }, on() { throw new Error('body listener'); } };
    const res = {};
    assert.equal(refuseOwned(req, res, { parseRequestUrl, json }), true, url);
    assert.deepEqual(res, { status: 503, body: ROUTE_REFUSAL });
  }
});

test('what Node keeps is not refused: the page reader, writes, other segments and shapes', () => {
  for (const url of [
    '/api/projects/p1/documents/pages', '/api/projects/p1/documents', '/api/projects/p1/upload', '/api/projects/p1/sources/sync',
    '/api/projects/p1/other/original', '/api/projects/p1/sources/text/', '/api/projects//sources/text', '/api/projects/a/b/sources/text',
    '/API/PROJECTS/P1/SOURCES/TEXT', '/api/projects/p1/files', '/api/projects/p1/config',
  ]) assert.equal(refuseOwned({ url, method: 'GET', headers: {} }, {}, { parseRequestUrl, json }), false, url);
  for (const method of ['POST', 'DELETE', 'PUT']) {
    assert.equal(refuseOwned({ url: '/api/projects/p1/sources/text', method, headers: {} }, {}, { parseRequestUrl, json }), false, method);
  }
  assert.equal(refuseOwned({ url: '//[', method: 'GET', headers: {} }, {}, { parseRequestUrl, json }), false);
});

test('the dead Node handlers are gone', () => {
  const routes = ''; assert.equal(fs.existsSync(path.join(__dirname, 'routes', 'projects.cjs')), false, 'no project route file is left (#2191 round 9)');
  for (const gone of ['sourceTextRoute', 'originalUpload', 'documentSources.readOriginal', '(pages|original)']) assert.equal(routes.includes(gone), false, gone);
  assert.equal(require('./source-text.cjs').textMissingNow, undefined);
});

// ── through the real router ─────────────────────────────────────────────────────

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-rust-project-reads-'));
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

test('through the router: the owned GETs are refused signed out and signed in; Node\'s gate still runs for the rest', async () => {
  const admin = seedAccount(dataDir, { username: 'reads-admin', displayName: 'Synthetic', role: 'admin', publicOrigin: 'http://localhost' });
  const member = seedAccount(dataDir, { username: 'reads-member', displayName: 'Synthetic', role: 'member' });
  const as = (a) => ({ cookie: a.cookie, origin: 'http://localhost', 'x-csrf-token': a.csrf });
  for (const url of ['/api/projects/p1/sources/text?name=a.md', '/api/projects/p1/documents/original?name=a.pdf', '/api/projects/p1/uploads/original?name=a', '/api/projects/p1/x/../uploads/original']) {
    for (const headers of [{}, as(member), as(admin)]) {
      const r = await request(url, { headers });
      assert.equal(r.status, 503, url);
      assert.deepEqual(r.json, ROUTE_REFUSAL, url);
      assert.equal(r.headers['x-noevia-api'], '1');
      assert.equal(r.headers['x-content-type-options'], 'nosniff', url);
    }
  }
  // Positive controls: Node's gate (the page reader is the front's since #2191 round 4,
  // rust-project-document-pages.test.cjs).
  assert.equal((await request('/api/projects/p1/browser', { method: 'POST', body: '{}' })).status, 401, 'signed out');
  assert.equal((await request('/api/projects/p1/sources/text', { method: 'POST', headers: as(admin), body: '{}' })).status, 404);
});
