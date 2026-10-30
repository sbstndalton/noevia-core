'use strict';
// #2191 round 4: POST /api/import/conversations is the Rust front's (noevia-rs crates/server-projects import.rs,
// tested there through real HTTP: Node's refusals, free and project chats, a project created through the
// front's create, transcripts never overwritten, a journal this process left finished, the audit row, tenant
// scope). Node refuses the POST before authentication, keeps the other methods' 405, and the import modules are gone.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const test = require('node:test');
const { OWNED_ROUTES, ROUTE_REFUSAL, owned, refuseOwned } = require('./rust-conversation-import.cjs');

const parseRequestUrl = (req, base = 'http://localhost') => { try { return new URL(req.url, base); } catch { return null; } };
const json = (res, status, body) => Object.assign(res, { status, body });

test('the owned list is exactly the import POST', () => {
  assert.deepEqual([...OWNED_ROUTES], ['POST /api/import/conversations']);
  assert.ok(Object.isFrozen(OWNED_ROUTES));
  assert.equal(ROUTE_REFUSAL.code, 'RUST_CONVERSATION_IMPORT_OWNED');
  assert.equal(owned('POST', '/api/import/conversations'), true);
  for (const m of ['GET', 'PUT', 'PATCH', 'DELETE', 'HEAD']) assert.equal(owned(m, '/api/import/conversations'), false, m);
  for (const p of ['/api/import/conversations/', '/api/import', '/api/import/conversations/x']) assert.equal(owned('POST', p), false, p);
});

test('an owned request is refused with a 503 before its body is read; the rest falls through', () => {
  for (const url of ['/api/import/conversations', '/api/import/conversations?x=1']) {
    const req = { url, method: 'POST', headers: { host: 'localhost' }, on() { throw new Error('body listener'); } };
    const res = {};
    assert.equal(refuseOwned(req, res, { parseRequestUrl, json }), true, url);
    assert.deepEqual(res, { status: 503, body: ROUTE_REFUSAL });
  }
  assert.equal(refuseOwned({ url: '/api/import/conversations', method: 'GET', headers: {} }, {}, { parseRequestUrl, json }), false);
  assert.equal(refuseOwned({ url: '//[', method: 'POST', headers: {} }, {}, { parseRequestUrl, json }), false);
});

test('the dead import modules are gone', () => {
  for (const gone of ['conversation-import.cjs', 'chat-import.cjs']) assert.equal(fs.existsSync(path.join(__dirname, gone)), false, gone);
  assert.equal(fs.readFileSync(path.join(__dirname, 'routes', 'import.cjs'), 'utf8').includes('importConversations'), false);
});

// ── through the real router ─────────────────────────────────────────────────────

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-rust-conversation-import-'));
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

test('through the router: the import is refused signed out and signed in; other methods keep their 405', async () => {
  const admin = seedAccount(dataDir, { username: 'import-admin', displayName: 'Synthetic', role: 'admin', publicOrigin: 'http://localhost' });
  const as = (a) => ({ cookie: a.cookie, origin: 'http://localhost', 'x-csrf-token': a.csrf, 'content-type': 'application/json' });
  for (const headers of [{}, as(admin)]) {
    const r = await request('/api/import/conversations', { method: 'POST', headers, body: { format: 'noevia-conversations-v1', chats: [] } });
    assert.deepEqual([r.status, r.json], [503, ROUTE_REFUSAL]);
  }
  const get = await request('/api/import/conversations', { headers: as(admin) });
  assert.deepEqual([get.status, get.json], [405, { error: 'method not allowed' }]);
  assert.equal(fs.existsSync(path.join(dataDir, 'users', admin.id, 'conversation-imports')), false, 'nothing written');
});
