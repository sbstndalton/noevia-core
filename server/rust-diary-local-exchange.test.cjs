'use strict';
// The Diary local exchange is the Rust front's (noevia-rs crates/server-diary local_exchange and
// bins/noevia-server tests/diary_local_exchange.rs). Node refuses it before authentication and before
// the inference gate, for every method; what the exchange holds here (the throttle chat shares, the
// gate, the backfill's pause) is taken by the front's admission lease (inference-admission-lease.test.cjs).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const test = require('node:test');
const { PATH, ROUTE_REFUSAL, owned, refuseOwned } = require('./rust-diary-local-exchange.cjs');

const parseRequestUrl = (req, base = 'http://localhost') => { try { return new URL(req.url, base); } catch { return null; } };
const json = (res, status, body) => Object.assign(res, { status, body });
const METHODS = ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'];

test('the exact path, every method, refused with a 503 and its code before the body is touched', () => {
  assert.equal(PATH, '/api/diary/local-exchange');
  assert.ok(Object.isFrozen(ROUTE_REFUSAL));
  assert.equal(ROUTE_REFUSAL.code, 'RUST_DIARY_LOCAL_EXCHANGE_OWNED');
  for (const method of METHODS) for (const suffix of ['', '?stream=1']) {
    const req = { url: PATH + suffix, method, headers: { host: 'localhost' }, on() { throw new Error('body listener'); }, [Symbol.asyncIterator]() { throw new Error('body read'); } };
    const res = {};
    assert.equal(refuseOwned(req, res, { parseRequestUrl, json }), true, method);
    assert.deepEqual(res, { status: 503, body: ROUTE_REFUSAL });
  }
});

test('nothing else is refused here: siblings, look-alikes, an unparseable target', () => {
  for (const url of ['/api/diary/local-exchange/', '/api/diary/local-exchangex', '/API/DIARY/LOCAL-EXCHANGE', '/api/diary/%6cocal-exchange',
    '/api/diary/history', '/api/diary/files', '/api/diary/exchanges', '/api/diary/source', '/api/chat']) {
    assert.equal(refuseOwned({ url, method: 'POST', headers: {} }, {}, { parseRequestUrl, json }), false, url);
    assert.equal(owned(new URL(url, 'http://h').pathname), false, url);
  }
  assert.equal(refuseOwned({ url: '//[', method: 'POST', headers: {} }, {}, { parseRequestUrl, json }), false);
});

test('Node\'s own exchange handler is gone; the stream relay stays for chat\'s Diary turns', () => {
  const routes = fs.readFileSync(path.join(__dirname, 'routes', 'diary.cjs'), 'utf8');
  for (const gone of ["'/api/diary/local-exchange'", 'rateLimited', 'proxyDiaryStream', '16 * 1024 * 1024']) assert.equal(routes.includes(gone), false, gone);
  assert.equal(typeof require('./diary-stream.cjs').proxyDiaryStream, 'function');
});

// ── through the real router ─────────────────────────────────────────────────────

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-rust-diary-lx-'));
process.env.UI_DATA_DIR = dataDir;
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
  const req = Readable.from(body ? [body] : []);
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
  return { status: res.statusCode, headers: out, json: parsed };
}

test('through the router: refused signed out and signed in, with or without the add-on, with the public headers', async () => {
  const off = seedAccount(dataDir, { username: 'lx-off', displayName: 'Synthetic', role: 'member', publicOrigin: 'http://localhost', diaryEnabled: false });
  const on = seedAccount(dataDir, { username: 'lx-on', displayName: 'Synthetic', role: 'member', diaryEnabled: true });
  const as = (a) => ({ cookie: a.cookie, origin: 'http://localhost', 'x-csrf-token': a.csrf });
  for (const method of ['GET', 'POST', 'PUT', 'DELETE']) for (const url of [PATH, '/api/diary/./local-exchange', `${PATH}?x=1`]) {
    for (const headers of [{}, as(off), as(on)]) {
      const r = await request(url, { method, headers, body: method === 'POST' ? '{"message":"synthetic","stream":true}' : undefined });
      assert.equal(r.status, 503, `${method} ${url}`);
      assert.deepEqual(r.json, ROUTE_REFUSAL, `${method} ${url}`);
      assert.equal(r.headers['x-noevia-api'], '1');
      assert.equal(r.headers['cache-control'], 'no-store');
      assert.equal(r.headers['x-content-type-options'], 'nosniff');
    }
  }
  // A look-alike is not the route: the ordinary chain (here the static 404 for an unknown API path).
  assert.notEqual((await request(`${PATH}/`, { method: 'POST', headers: as(on), body: '{}' })).status, 503);
});
