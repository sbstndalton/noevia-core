'use strict';
// GET /api/models/mtp-artifact is the Rust front's (noevia-rs bins/noevia-server model_maint/mtp_artifact.rs,
// which replays this Core's own answers for synthetic sources byte for byte, tests/mtp_artifact.rs). Node
// refuses the GET before authentication; every other method, every other model route and every other path
// shape still runs Node's ordinary chain.
//
// The first block is the pure function; the second goes through the real router (handleRequest).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const test = require('node:test');
const { OWNED_PATHS, ROUTE_REFUSAL, owned, refuseOwned } = require('./rust-mtp-artifact.cjs');

const parseRequestUrl = (req, base = 'http://localhost') => { try { return new URL(req.url, base); } catch { return null; } };
const json = (res, status, body) => Object.assign(res, { status, body });

test('the owned list is exactly the front\'s artifact check, GET only', () => {
  assert.deepEqual([...OWNED_PATHS], ['/api/models/mtp-artifact']);
  assert.ok(Object.isFrozen(OWNED_PATHS));
  assert.ok(Object.isFrozen(ROUTE_REFUSAL));
  assert.equal(ROUTE_REFUSAL.code, 'RUST_MTP_ARTIFACT_OWNED');
  assert.equal(owned('GET', '/api/models/mtp-artifact'), true);
  for (const m of ['HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']) assert.equal(owned(m, '/api/models/mtp-artifact'), false, m);
});

test('an owned GET is refused with a 503 and its code, before the body is touched', () => {
  for (const suffix of ['', '?repo=bad', '?repo=synthetic%2Fm&variant=Q8_0', '?repo=..%2F..']) {
    const req = { url: '/api/models/mtp-artifact' + suffix, method: 'GET', headers: { host: 'localhost' }, on() { throw new Error('body listener'); } };
    const res = {};
    assert.equal(refuseOwned(req, res, { parseRequestUrl, json }), true, suffix);
    assert.deepEqual(res, { status: 503, body: ROUTE_REFUSAL });
  }
});

test('what Node keeps is not refused: other methods, the other model routes, other path shapes', () => {
  for (const method of ['HEAD', 'POST', 'PUT', 'DELETE']) {
    assert.equal(refuseOwned({ url: '/api/models/mtp-artifact', method, headers: {} }, {}, { parseRequestUrl, json }), false, method);
  }
  for (const url of ['/api/models/pull', '/api/models/reranker', '/api/models/mtp-artifact/', '/api/models/mtp-artifactx', '/API/MODELS/MTP-ARTIFACT', '/api/models/%6Dtp-artifact', '/api/models/mtp-artifact/x']) {
    assert.equal(refuseOwned({ url, method: 'GET', headers: {} }, {}, { parseRequestUrl, json }), false, url);
  }
  assert.equal(refuseOwned({ url: '//[', method: 'GET', headers: {} }, {}, { parseRequestUrl, json }), false);
});

test('the dead Node artifact check is gone', () => {
  const routes = fs.readFileSync(path.join(__dirname, 'routes', 'models.cjs'), 'utf8');
  for (const gone of ['Could not resolve selected files', 'Variant no longer available', 'mtp-artifact.cjs\')', 'modelManager.variants']) assert.equal(routes.includes(gone), false, gone);
  for (const gone of ['mtp-artifact.cjs', 'llamacpp-variants.cjs']) assert.equal(fs.existsSync(path.join(__dirname, gone)), false, gone);
  for (const m of ['llamacpp-manager.cjs', 'model-manager.cjs']) assert.equal(fs.readFileSync(path.join(__dirname, m), 'utf8').includes('variants'), false, m);
  const index = fs.readFileSync(path.join(__dirname, 'index.cjs'), 'utf8');
  assert.ok(index.includes("require('./rust-mtp-artifact.cjs').refuseOwned("), 'the supervisor marker');
});

// ── through the real router ─────────────────────────────────────────────────────

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-rust-mtp-artifact-'));
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

test('through the router: the owned GET is refused signed out and signed in; the other methods run as before', async () => {
  const admin = seedAccount(dataDir, { username: 'mtp-admin', displayName: 'Synthetic', role: 'admin', publicOrigin: 'http://localhost' });
  const member = seedAccount(dataDir, { username: 'mtp-member', displayName: 'Synthetic', role: 'member' });
  const as = (a) => ({ cookie: a.cookie, origin: 'http://localhost', 'x-csrf-token': a.csrf });
  for (const url of ['/api/models/mtp-artifact?repo=synthetic%2Fm&variant=Q8_0', '/api/models/mtp-artifact?repo=bad', '/api/models/./mtp-artifact', '/api/models/x/../mtp-artifact?repo=']) {
    for (const headers of [{}, as(member), as(admin)]) {
      const r = await request(url, { headers });
      assert.equal(r.status, 503, url);
      assert.deepEqual(r.json, ROUTE_REFUSAL, url);
      assert.equal(r.headers['x-noevia-api'], '1');
      assert.equal(r.headers['x-content-type-options'], 'nosniff', url);
    }
  }
  // Positive controls: the other methods keep Node's gate and the administrator check for writes.
  const p = '/api/models/mtp-artifact';
  assert.equal((await request(p, { method: 'POST', body: '{}' })).status, 401, 'signed out');
  const memberPost = await request(p, { method: 'POST', headers: as(member), body: '{}' });
  assert.deepEqual([memberPost.status, memberPost.json], [403, { error: 'administrator required' }]);
  const adminPost = await request(p, { method: 'POST', headers: as(admin), body: '{}' });
  assert.notEqual(adminPost.status, 503);
  assert.notDeepEqual(adminPost.json, ROUTE_REFUSAL);
  // A kept model read still answers here.
  assert.equal((await request('/api/models/machines')).status, 401);
});
