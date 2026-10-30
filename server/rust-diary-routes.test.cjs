'use strict';
// #2206: the rest of the Diary routes the web client names are the Rust front's (noevia-rs
// crates/server-diary, bins/noevia-server diary_routes.rs; capability rust-diary-routes). Node refuses
// them before authentication, for the methods it used to answer, and keeps the local exchange and the
// paths the web client never names. The routes' behaviour itself is proven against a synthetic sidecar
// in noevia-rs crates/server-diary/tests (connector.rs, status_exchanges.rs) and bins/noevia-server/tests/diary.rs.
//
// The first block is the pure function; the second goes through the real router (handleRequest).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const test = require('node:test');
const { FIXED, ROUTE_REFUSAL, SIGNAL, TABLE, owned, refuseOwned } = require('./rust-diary-routes.cjs');

const parseRequestUrl = (req, base = 'http://localhost') => { try { return new URL(req.url, base); } catch { return null; } };
const json = (res, status, body) => Object.assign(res, { status, body });
const METHODS = ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'];
const ID = 'a'.repeat(32);

// noevia-rs contracts/http/routes.toml, the owner = "rust" entries of these paths, with their methods
// (null: every method). Keep them equal.
const RUST_ROUTES = [
  ['/api/diary', null], ['/api/diary-connector', null], ['/api/diary/storage-status', null],
  ['/api/diary/context', ['GET', 'POST']], ['/api/diary/exchanges', ['GET', 'POST']],
  ['/api/profile/diary-connectors', ['GET', 'POST']], [`/api/profile/diary-connectors/${ID}`, ['DELETE']],
];

test('Node refuses exactly the paths and methods the front\'s route table gives the front', () => {
  for (const [p, methods] of RUST_ROUTES) {
    for (const m of METHODS) assert.equal(owned(m, p), methods === null || methods.includes(m), `${m} ${p}`);
  }
  assert.deepEqual(Object.keys(FIXED).sort(), RUST_ROUTES.filter(([p]) => !p.includes(ID)).map(([p]) => p).sort());
  assert.ok(Object.isFrozen(FIXED));
  assert.equal(ROUTE_REFUSAL.code, 'RUST_DIARY_ROUTES_OWNED');
  assert.equal(TABLE, 'diary_connectors');
  assert.equal(SIGNAL, 'active.json');
  assert.equal(require('./diary-jobs.cjs').SIGNAL, SIGNAL, 'the file diary-jobs.cjs writes is the one the front reads');
  // The front owns DELETE on any one segment under the connectors (it answers a malformed id with the unknown-path 404).
  assert.equal(owned('DELETE', '/api/profile/diary-connectors/not-an-id'), true);
  assert.equal(owned('DELETE', '/api/profile/diary-connectors/a/b'), false);
  assert.equal(owned('DELETE', '/api/profile/diary-connectors/'), false);
  assert.equal(owned('GET', `/api/profile/diary-connectors/${ID}`), false, 'core mounted only DELETE there');
});

test('what stays Node\'s is not refused: the local exchange, the paths the web client never names, look-alikes', () => {
  for (const url of [
    '/api/diary/local-exchange', '/api/diary/history', '/api/diary/files', '/api/diary/file', '/api/diary/workspace-trash',
    '/api/diary/external-sources', '/api/diary/external-sources/import', '/api/diary/entries/edit',
    // the first round's routes are rust-diary.cjs's
    '/api/diary/source', '/api/diary/today', '/api/diary/workspace-import',
    // core compared `p === '...'` exactly
    '/api/diary/', '/api/diary/exchanges/', '/api/diary/context/', '/api/diary-connector/', '/api/diary-connectors', '/api/diary/storage-statusx',
    '/API/DIARY', '/api/diary/%65xchanges', '/api/profile/diary-connectors/', '/api/profile', '/api/chat',
  ]) {
    for (const method of ['GET', 'POST', 'DELETE']) {
      assert.equal(refuseOwned({ url, method, headers: {} }, {}, { parseRequestUrl, json }), false, `${method} ${url}`);
    }
  }
  assert.equal(refuseOwned({ url: '//[', method: 'GET', headers: {} }, {}, { parseRequestUrl, json }), false);
});

test('every owned request is refused with a 503 and its code before the body is touched', () => {
  for (const [pathname, methods] of RUST_ROUTES) for (const method of (methods || METHODS)) {
    for (const suffix of ['', '?day=2026-10-30']) {
      const req = { url: pathname + suffix, method, headers: { host: 'localhost' }, on() { throw new Error('body listener'); }, [Symbol.asyncIterator]() { throw new Error('body read'); } };
      const res = {};
      assert.equal(refuseOwned(req, res, { parseRequestUrl, json }), true, `${method} ${pathname}${suffix}`);
      assert.deepEqual(res, { status: 503, body: ROUTE_REFUSAL });
    }
  }
});

test('the Node duplicates are gone', () => {
  const read = (...p) => fs.readFileSync(path.join(__dirname, ...p), 'utf8');
  const routes = read('routes', 'diary.cjs');
  for (const gone of ['connector(', 'connectors(', "'/api/diary/exchanges'", "'/api/diary/storage-status'", 'diaryConnectors', 'connectorRate', 'readObject', 'automaticStorage', 'diary-jobs.cjs']) {
    assert.equal(routes.includes(gone), false, gone);
  }
  assert.equal(read('routes', 'projects.cjs').includes("'/api/diary/context' &&"), false);
  const jobs = require('./diary-jobs.cjs');
  assert.deepEqual(Object.keys(jobs).sort(), ['SIGNAL', 'start', 'validDay'], 'list and acknowledge are the front\'s');
  const connectors = require('./diary-connectors.cjs');
  assert.deepEqual(Object.keys(connectors), ['ensureTable']);
  const diary = require('./diary.cjs').createDiary({
    fs, path, fetchJson: async () => ({}), DIARY_BASE: 'http://diary', DIARY_TOKEN: '', DIARY_SOURCE: 'sidecar', requestScope: new (require('node:async_hooks').AsyncLocalStorage)(),
    authService: {}, endpointApproved: () => true,
  });
  assert.equal('connectorFiles' in diary || 'callDiaryFile' in diary, false);
  assert.equal('newProject' in require('./diary-extras.cjs'), false);
  assert.equal('statusFor' in require('./storage-latch.cjs').createStorageLatch(), false);
  // The marker the web supervisor and the release assembler look for.
  assert.ok(read('index.cjs').includes("require('./rust-diary-routes.cjs')"));
  // The inference maintenance gate is entered for the Diary routes Node answers and for no moved one
  // (handleRequest runs before the refusal, so a held gate must not turn a refusal into a gate 503).
  assert.match(read('index.cjs'), /pathname\.startsWith\('\/api\/diary\/'\) && !require\('\.\/rust-diary\.cjs'\)\.owned\(pathname\) && !require\('\.\/rust-diary-routes\.cjs'\)\.owned\(req\.method,pathname\)/);
});

test('ensureTable makes the table in the shape the front writes and a rollback reads, and is idempotent', () => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec('CREATE TABLE users(id TEXT PRIMARY KEY)');
  require('./diary-connectors.cjs').ensureTable(db);
  require('./diary-connectors.cjs').ensureTable(db);
  assert.deepEqual(db.prepare('PRAGMA table_info(diary_connectors)').all().map((c) => [c.name, c.type, c.notnull, c.pk]),
    [['id', 'TEXT', 0, 1], ['user_id', 'TEXT', 1, 0], ['name', 'TEXT', 1, 0], ['token_hash', 'TEXT', 1, 0], ['created_at', 'INTEGER', 1, 0]]);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_list(diary_connectors)').all().map((f) => [f.table, f.from, f.to, f.on_delete]), [['users', 'user_id', 'id', 'CASCADE']]);
});

// ── through the real router ─────────────────────────────────────────────────────

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-rust-diary-routes-'));
process.env.UI_DATA_DIR = dataDir;
// #1071: Node saves projects.json / free-chats.json only through the Rust project store.
require('../tests/server/project-store-server.cjs').installProjectStore(dataDir);
process.env.PUBLIC_ORIGIN = 'http://localhost';
process.env.LEGACY_AUTH_COMPAT = 'false';
// Nothing listens here: a request that wrongly reached the sidecar would fail, not answer.
process.env.DIARY_BASE_URL = 'http://127.0.0.1:9';
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

test('through the router: owned routes are refused signed out and signed in; the local exchange and the unnamed paths still answer here', async () => {
  const member = seedAccount(dataDir, { username: 'routes-off', displayName: 'Synthetic', role: 'member', publicOrigin: 'http://localhost', diaryEnabled: false });
  const withDiary = seedAccount(dataDir, { username: 'routes-on', displayName: 'Synthetic', role: 'member', diaryEnabled: true });
  const as = (a) => ({ cookie: a.cookie, origin: 'http://localhost', 'x-csrf-token': a.csrf });
  for (const [method, url] of [
    ['GET', '/api/diary'], ['POST', '/api/diary'], ['GET', '/api/diary-connector'], ['POST', '/api/diary-connector'],
    ['GET', '/api/diary/storage-status'], ['POST', '/api/diary/storage-status'],
    ['GET', '/api/diary/context'], ['POST', '/api/diary/context'], ['GET', '/api/diary/exchanges?day=2026-10-30'], ['POST', '/api/diary/exchanges'],
    ['GET', '/api/profile/diary-connectors'], ['POST', '/api/profile/diary-connectors'], ['DELETE', `/api/profile/diary-connectors/${ID}`],
    // Routed on the WHATWG pathname, as the router routes.
    ['GET', '/api/diary/./exchanges'], ['GET', '/api/diary/x/../storage-status'],
  ]) {
    for (const headers of [{}, as(member), as(withDiary), { authorization: 'Bearer nv_diary_x' }]) {
      const r = await request(url, { method, headers, body: method === 'POST' ? '{}' : undefined });
      assert.equal(r.status, 503, `${method} ${url}`);
      assert.deepEqual(r.json, ROUTE_REFUSAL, `${method} ${url}`);
      assert.equal(r.headers['x-noevia-api'], '1');
      assert.equal(r.headers['cache-control'], 'no-store');
      assert.equal(r.headers['x-content-type-options'], 'nosniff', `${method} ${url}`);
      assert.equal(r.headers['strict-transport-security'], 'max-age=15552000', `${method} ${url}`);
    }
  }
  // Positive controls: what Node keeps still runs the ordinary chain (auth, then the add-on gate).
  for (const url of ['/api/diary/history', '/api/diary/workspace-trash', '/api/diary/files']) {
    assert.equal((await request(url)).status, 401, `${url} signed out`);
    const off = await request(url, { headers: as(member) });
    assert.equal(off.status, 404, `${url} without the add-on`);
    assert.deepEqual(off.json, { error: 'Diary add-on is disabled' });
  }
  const local = await request('/api/diary/local-exchange', { method: 'POST', headers: as(member), body: '{}' });
  assert.deepEqual([local.status, local.json], [404, { error: 'Diary add-on is disabled' }]);
  // An owned path with another method is Node's old unknown-path answer, as before.
  const put = await request('/api/diary/exchanges', { method: 'PUT', headers: as(withDiary), body: '{}' });
  assert.equal(put.status, 404);
  const slash = await request('/api/diary/exchanges/', { headers: as(withDiary) });
  assert.equal(slash.status, 404);
});
