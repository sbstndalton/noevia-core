'use strict';
// #2185: the Diary routes that are only a proxy and a policy are the Rust front's (noevia-rs
// crates/server-diary). Node refuses them before authentication, for every method, and the routes
// that read Node's own memory still answer here. The routes' behaviour itself (the add-on gate, the
// method guards, the month list, the day read, the caps and deadlines, the 428 retry) is proven
// against a synthetic sidecar in noevia-rs crates/server-diary/tests/sidecar.rs.
//
// The first block is the pure function; the second goes through the real router (handleRequest).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const test = require('node:test');
const { OWNED_PATHS, ROUTE_REFUSAL, owned, refuseOwned } = require('./rust-diary.cjs');

const parseRequestUrl = (req, base = 'http://localhost') => { try { return new URL(req.url, base); } catch { return null; } };
const json = (res, status, body) => Object.assign(res, { status, body });
const METHODS = ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'];

test('the owned list is exactly the five proxy-only routes of the front\'s route table', () => {
  assert.deepEqual([...OWNED_PATHS], [
    '/api/diary/source', '/api/diary/today', '/api/diary/storage-import', '/api/diary/workspace-export', '/api/diary/workspace-import',
  ]);
  assert.ok(Object.isFrozen(OWNED_PATHS));
  assert.deepEqual(ROUTE_REFUSAL.code, 'RUST_DIARY_OWNED');
});

test('every owned route is refused with a 503 and its code, for every method, before the body is touched', () => {
  for (const pathname of OWNED_PATHS) for (const method of METHODS) {
    for (const suffix of ['', '?month=2026-09', '?action=apply&fingerprint=x']) {
      const req = { url: pathname + suffix, method, headers: { host: 'localhost' }, on() { throw new Error('body listener'); }, [Symbol.asyncIterator]() { throw new Error('body read'); } };
      const res = {};
      assert.equal(refuseOwned(req, res, { parseRequestUrl, json }), true, `${method} ${pathname}${suffix}`);
      assert.deepEqual(res, { status: 503, body: ROUTE_REFUSAL });
    }
  }
});

test('what Node keeps is not refused: the memory-bound routes, the unnamed aliases, and any other path shape', () => {
  for (const url of [
    '/api/diary', '/api/diary-connector', '/api/diary/context', '/api/diary/exchanges', '/api/diary/local-exchange', '/api/diary/storage-status',
    '/api/profile/diary-connectors', `/api/profile/diary-connectors/${'a'.repeat(32)}`,
    '/api/diary/history', '/api/diary/files', '/api/diary/file', '/api/diary/workspace-trash', '/api/diary/external-sources', '/api/diary/entries/edit',
    // core matched `p === '/api/diary/source'` exactly
    '/api/diary/source/', '/api/diary/sourcex', '/api/diary/source/x', '/API/DIARY/SOURCE', '/api/diary/%73ource', '/api/chat',
  ]) {
    for (const method of ['GET', 'POST']) {
      assert.equal(refuseOwned({ url, method, headers: {} }, {}, { parseRequestUrl, json }), false, `${method} ${url}`);
    }
    assert.equal(owned(url), false, url);
  }
  // An unparseable target is the ordinary 400 later in the chain, not a refusal.
  assert.equal(refuseOwned({ url: '//[', method: 'GET', headers: {} }, {}, { parseRequestUrl, json }), false);
});

test('the dead proxy code is gone, and only what the kept routes and chat still use is left', () => {
  assert.equal(fs.existsSync(path.join(__dirname, 'workspace-import.cjs')), false);
  assert.equal(fs.existsSync(path.join(__dirname, 'workspace-export.cjs')), false);
  const routes = fs.readFileSync(path.join(__dirname, 'routes', 'diary.cjs'), 'utf8');
  for (const gone of ['proxyWorkspaceImport', 'proxyWorkspaceExport', "'/api/diary/source'", "'/api/diary/today'", "'/api/diary/storage-import'", "'/api/diary/workspace-import'", "'/api/diary/workspace-export'", 'listMonths']) {
    assert.equal(routes.includes(gone), false, gone);
  }
  assert.equal('listMonths' in require('./diary.cjs').createDiary({
    fs, path, fetchJson: async () => ({}), DIARY_BASE: 'http://diary', DIARY_TOKEN: '', DIARY_SOURCE: 'sidecar', requestScope: new (require('node:async_hooks').AsyncLocalStorage)(),
    authService: {}, endpointApproved: () => true, workspaceStore: {},
  }).corpusSource, false);
});

// ── through the real router ─────────────────────────────────────────────────────

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-rust-diary-'));
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

test('through the router: owned routes are refused signed out and signed in, kept routes answer as before', async () => {
  const member = seedAccount(dataDir, { username: 'diary-off', displayName: 'Synthetic', role: 'member', publicOrigin: 'http://localhost', diaryEnabled: false });
  const withDiary = seedAccount(dataDir, { username: 'diary-on', displayName: 'Synthetic', role: 'member', diaryEnabled: true });
  const as = (a) => ({ cookie: a.cookie, origin: 'http://localhost', 'x-csrf-token': a.csrf });
  for (const [method, url] of [
    ['GET', '/api/diary/source'], ['GET', '/api/diary/today?month=2026-09'], ['POST', '/api/diary/storage-import'],
    ['GET', '/api/diary/workspace-export'], ['POST', '/api/diary/workspace-import?action=preview'], ['DELETE', '/api/diary/source'],
  ]) {
    for (const headers of [{}, as(member), as(withDiary)]) {
      const r = await request(url, { method, headers, body: method === 'POST' ? '{}' : undefined });
      assert.equal(r.status, 503, `${method} ${url}`);
      assert.deepEqual(r.json, ROUTE_REFUSAL, `${method} ${url}`);
      assert.equal(r.headers['x-noevia-api'], '1');
      assert.equal(r.headers['cache-control'], 'no-store');
    }
  }
  // Positive controls: the routes Node keeps still run the ordinary chain (auth, then the add-on gate).
  for (const url of ['/api/diary/storage-status', '/api/diary/history', '/api/diary/exchanges', '/api/diary/workspace-trash', '/api/diary/files']) {
    assert.equal((await request(url)).status, 401, `${url} signed out`);
    const off = await request(url, { headers: as(member) });
    assert.equal(off.status, 404, `${url} without the add-on`);
    assert.deepEqual(off.json, { error: 'Diary add-on is disabled' });
  }
  // A kept method guard, as the combined storage route had it.
  const wrong = await request('/api/diary/storage-status', { method: 'POST', headers: as(withDiary), body: '{}' });
  assert.deepEqual([wrong.status, wrong.json], [405, { error: 'Method not allowed' }]);
  // A trailing slash is not the owned route: it falls through to the static 404, as it always did.
  const slash = await request('/api/diary/source/', { headers: as(withDiary) });
  assert.equal(slash.status, 404);
});
