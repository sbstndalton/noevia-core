'use strict';
// #2187: GET /api/models/capabilities and GET /api/models/hardware are the Rust front's (noevia-rs
// bins/noevia-server model_routes.rs, tested there through real HTTP with admin, member and device
// sessions). Node refuses both GETs before authentication; every other method, every other model
// route and every other path shape still runs Node's ordinary chain.
//
// The first block is the pure function; the second goes through the real router (handleRequest).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const test = require('node:test');
const { OWNED_PATHS, ROUTE_REFUSAL, owned, refuseOwned } = require('./rust-models.cjs');

const parseRequestUrl = (req, base = 'http://localhost') => { try { return new URL(req.url, base); } catch { return null; } };
const json = (res, status, body) => Object.assign(res, { status, body });

test('the owned list is exactly the front\'s two model reads, GET only', () => {
  assert.deepEqual([...OWNED_PATHS], ['/api/models/capabilities', '/api/models/hardware']);
  assert.ok(Object.isFrozen(OWNED_PATHS));
  assert.equal(ROUTE_REFUSAL.code, 'RUST_MODELS_OWNED');
  for (const p of OWNED_PATHS) {
    assert.equal(owned('GET', p), true);
    for (const m of ['HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']) assert.equal(owned(m, p), false, `${m} ${p}`);
  }
});

test('an owned GET is refused with a 503 and its code, before the body is touched', () => {
  for (const pathname of OWNED_PATHS) for (const suffix of ['', '?model=x']) {
    const req = { url: pathname + suffix, method: 'GET', headers: { host: 'localhost' }, on() { throw new Error('body listener'); } };
    const res = {};
    assert.equal(refuseOwned(req, res, { parseRequestUrl, json }), true, pathname + suffix);
    assert.deepEqual(res, { status: 503, body: ROUTE_REFUSAL });
  }
});

test('what Node keeps is not refused: other methods, the other model routes, other path shapes', () => {
  for (const method of ['HEAD', 'POST', 'PUT', 'DELETE']) for (const url of OWNED_PATHS) {
    assert.equal(refuseOwned({ url, method, headers: {} }, {}, { parseRequestUrl, json }), false, `${method} ${url}`);
  }
  for (const url of [
    '/api/model-manager', '/api/model-manager/models', '/api/models/autotune', '/api/models/autotune/untuned', '/api/models/calibration',
    '/api/models/estimate', '/api/models/evidence', '/api/models/machines',
    '/api/models/preset', '/api/models/downloads',
    '/api/models/capabilities/', '/api/models/hardwarex', '/api/models/hardware/x', '/API/MODELS/HARDWARE', '/api/models/%68ardware',
  ]) {
    assert.equal(refuseOwned({ url, method: 'GET', headers: {} }, {}, { parseRequestUrl, json }), false, url);
  }
  assert.equal(refuseOwned({ url: '//[', method: 'GET', headers: {} }, {}, { parseRequestUrl, json }), false);
});

test('the dead Node handlers are gone', () => {
  assert.equal(fs.existsSync(path.join(__dirname, 'model-hardware.cjs')), false);
  const routes = fs.readFileSync(path.join(__dirname, 'routes', 'models.cjs'), 'utf8');
  for (const gone of ['systemInfo', 'modelHardware', "'/api/models/capabilities'", 'modelManagement:']) assert.equal(routes.includes(gone), false, gone);
  for (const file of ['model-manager.cjs', 'llamacpp-manager.cjs']) assert.equal(fs.readFileSync(path.join(__dirname, file), 'utf8').includes('systemInfo'), false, file);
});

// ── through the real router ─────────────────────────────────────────────────────

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-rust-models-'));
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

test('through the router: the owned GETs are refused signed out and signed in; the rest runs as before', async () => {
  const admin = seedAccount(dataDir, { username: 'models-admin', displayName: 'Synthetic', role: 'admin', publicOrigin: 'http://localhost' });
  const member = seedAccount(dataDir, { username: 'models-member', displayName: 'Synthetic', role: 'member' });
  const as = (a) => ({ cookie: a.cookie, origin: 'http://localhost', 'x-csrf-token': a.csrf });
  for (const url of ['/api/models/capabilities', '/api/models/hardware', '/api/models/./hardware', '/api/models/x/../capabilities']) {
    for (const headers of [{}, as(member), as(admin)]) {
      const r = await request(url, { headers });
      assert.equal(r.status, 503, url);
      assert.deepEqual(r.json, ROUTE_REFUSAL, url);
      assert.equal(r.headers['x-noevia-api'], '1');
      assert.equal(r.headers['x-content-type-options'], 'nosniff', url);
      assert.equal(r.headers['strict-transport-security'], 'max-age=15552000', url);
    }
  }
  // Positive controls: the hardware path's other methods keep Node's gate and 405.
  assert.equal((await request('/api/models/hardware', { method: 'PUT', body: '{}' })).status, 401, 'signed out');
  const memberPut = await request('/api/models/hardware', { method: 'PUT', headers: as(member), body: '{}' });
  assert.deepEqual([memberPut.status, memberPut.json], [403, { error: 'administrator required' }]);
  const adminPut = await request('/api/models/hardware', { method: 'PUT', headers: as(admin), body: '{}' });
  assert.deepEqual([adminPut.status, adminPut.json], [405, { error: 'Method not allowed' }]);
  // A kept model read still answers here.
  assert.equal((await request('/api/models/machines')).status, 401);
});
