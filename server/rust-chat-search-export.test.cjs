'use strict';
// GET /api/chats/search (#1450) and GET /api/chats/{chatId}/export (#1471) are the Rust front's (noevia-rs
// bins/noevia-server tests/chat_lists_read.rs replays core's own answers, recorded by its
// tests/chat-lists-oracle.cjs, through the front). Node refuses both GETs before authentication; every other
// method and spelling keeps Node's own answer.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const test = require('node:test');
const search = require('./rust-chat-search.cjs');
const exportRoute = require('./rust-chat-export.cjs');

const parseRequestUrl = (req, base = 'http://localhost') => { try { return new URL(req.url, base); } catch { return null; } };
const json = (res, status, body) => Object.assign(res, { status, body });
const refuse = (mod, method, url) => { const res = {}; return mod.refuseOwned({ url, method, headers: {}, on() { throw new Error('body listener'); } }, res, { parseRequestUrl, json }) ? res : null; };

test('the search refuses exactly its GET, before authentication', () => {
  assert.deepEqual([...search.OWNED_ROUTES], ['GET /api/chats/search']);
  assert.equal(search.ROUTE_REFUSAL.code, 'RUST_CHAT_SEARCH_OWNED');
  for (const u of ['/api/chats/search', '/api/chats/search?q=needle', '/api/chats/search?q=']) assert.deepEqual(refuse(search, 'GET', u), { status: 503, body: search.ROUTE_REFUSAL }, u);
  for (const [m, u] of [['POST', '/api/chats/search'], ['HEAD', '/api/chats/search'], ['GET', '/api/chats/search/'], ['GET', '/api/chats/searchx'], ['GET', '/api/chats/search/export'], ['GET', '/api/chats']]) {
    assert.equal(refuse(search, m, u), null, `${m} ${u}`);
  }
});

test('the download refuses exactly its GET on the old matcher, before authentication', () => {
  assert.deepEqual([...exportRoute.OWNED_ROUTES], ['GET /api/chats/{chatId}/export']);
  assert.equal(exportRoute.ROUTE_REFUSAL.code, 'RUST_CHAT_EXPORT_OWNED');
  for (const u of ['/api/chats/c1/export', '/api/chats/c%201/export', '/api/chats/%E0%A4%A/export', '/api/chats/search/export', '/api/chats/c1/export?x=1']) {
    assert.deepEqual(refuse(exportRoute, 'GET', u), { status: 503, body: exportRoute.ROUTE_REFUSAL }, u);
  }
  for (const [m, u] of [['POST', '/api/chats/c1/export'], ['HEAD', '/api/chats/c1/export'], ['DELETE', '/api/chats/c1/export'], ['GET', '/api/chats/c1/export/'], ['GET', '/api/chats//export'], ['GET', '/api/chats/a/b/export'], ['GET', '/api/export/conversations']]) {
    assert.equal(refuse(exportRoute, m, u), null, `${m} ${u}`);
  }
});

test('Node keeps neither handler: the list mount answers neither route', () => {
  const lists = fs.readFileSync(path.join(__dirname, 'routes', 'chat-lists.cjs'), 'utf8');
  assert.equal(lists.includes("p === '/api/chats/search'"), false);
  assert.equal(lists.includes('SEARCH_MAX_CHATS'), false);
  assert.equal(lists.includes('chatMarkdown('), false);
  assert.equal(lists.includes('Content-Disposition'), false);
});

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-rust-chat-lists-'));
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
  const res = new Writable({ write(chunk, _e, cb) { chunks.push(Buffer.from(chunk)); cb(); } });
  res.statusCode = 200;
  res.headersSent = false;
  res.setHeader = () => {};
  res.writeHead = (status) => { res.statusCode = status; res.headersSent = true; return res; };
  const done = new Promise((resolve, reject) => { res.once('finish', resolve); res.once('error', reject); });
  await index.handleRequest(req, res);
  await done;
  const text = Buffer.concat(chunks).toString('utf8');
  let parsed = null; try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.statusCode, text, json: parsed };
}

test('through the router: refused signed out and signed in; the other spellings keep their gate', async () => {
  const member = seedAccount(dataDir, { username: 'chat-lists-member', displayName: 'Synthetic', role: 'member', publicOrigin: 'http://localhost' });
  for (const headers of [{}, { cookie: member.cookie }]) {
    const s = await request('/api/chats/search?q=needle', { headers });
    assert.equal(s.status, 503);
    assert.deepEqual(s.json, search.ROUTE_REFUSAL);
    const e = await request('/api/chats/c1/export', { headers });
    assert.equal(e.status, 503);
    assert.deepEqual(e.json, exportRoute.ROUTE_REFUSAL);
  }
  assert.equal((await request('/api/chats/search/')).status, 401);
  assert.equal((await request('/api/chats/c1/export/')).status, 401);
  assert.equal((await request('/api/chats/search/', { headers: { cookie: member.cookie } })).status, 404);
});
