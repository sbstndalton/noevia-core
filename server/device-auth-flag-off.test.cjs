'use strict';

// Native-client sign-in (#555) with the nativeClientAuth feature OFF (its default), through the
// real router: the approval page answers 404, and nothing else changes. The device endpoints are
// the Rust front's (#1071; it answers their 404 while the feature is off): Node refuses a request
// that bypassed the front, signed in or not.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const test = require('node:test');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-device-off-'));
process.env.UI_DATA_DIR = dataDir;
// #1071: Node saves projects.json / free-chats.json only through the Rust project store.
require('../tests/server/project-store-server.cjs').installProjectStore(dataDir);
process.env.PUBLIC_ORIGIN = 'http://localhost';
process.env.LEGACY_AUTH_COMPAT = 'false';
delete process.env.NOEVIA_FEATURE_NATIVE_CLIENT_AUTH;

const originalWarn = console.warn;
console.warn = () => {};
const { handleRequest } = require('./index.cjs');
console.warn = originalWarn;

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

async function request(url, { method = 'GET', headers = {}, body } = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  const req = Readable.from(payload ? [payload] : []);
  Object.assign(req, { url, method, headers: { host: 'localhost', ...headers }, socket: { remoteAddress: '127.0.0.1' } });
  const chunks = []; const out = {};
  const res = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  res.statusCode = 200; res.headersSent = false;
  res.setHeader = (k, v) => { out[k.toLowerCase()] = v; };
  res.writeHead = (s, h = {}) => { res.statusCode = s; res.headersSent = true; for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v; return res; };
  const done = new Promise((resolve) => res.once('finish', resolve));
  await handleRequest(req, res); await done;
  return { status: res.statusCode, headers: out, text: Buffer.concat(chunks).toString('utf8') };
}

test('with the feature off, the approval page is 404 and the device endpoints are refused, signed in or not', async () => {
  const { cookie, csrf } = require('../tests/server/seed-account.cjs').seedAccount(dataDir, { username: 'offqa', publicOrigin: 'http://localhost' });
  const signedIn = { cookie, origin: 'http://localhost', 'x-csrf-token': csrf, 'content-type': 'application/json' };

  const routes = [
    ['POST', '/api/auth/device/code', { client_name: 'x' }],
    ['POST', '/api/auth/device/token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: 'x' }],
    ['POST', '/api/auth/device/lookup', { user_code: 'BCDF-GHJK' }],
    ['POST', '/api/auth/device/approve', { user_code: 'BCDF-GHJK', approve: true }],
    ['GET', '/api/auth/devices'],
    ['DELETE', `/api/auth/devices/${'a'.repeat(32)}`],
  ];
  for (const headers of [{}, signedIn]) {
    for (const [method, url, body] of routes) {
      const r = await request(url, { method, body, headers });
      assert.equal(r.status, 503, `${method} ${url} (${headers.cookie ? 'signed in' : 'signed out'}) -> ${r.status}`);
      assert.equal(JSON.parse(r.text).code, 'RUST_AUTH_OWNED');
    }
    // The approval page's 404 is the Rust front's (#2190, public_pages.rs); Node refuses the page.
    const page = await request('/device', { headers });
    assert.equal(page.status, 503);
    assert.equal(JSON.parse(page.text).code, 'RUST_PUBLIC_PAGES_OWNED');
  }
  // A device-shaped bearer means nothing; cookie sessions and CSRF behave exactly as before.
  assert.equal((await request('/api/workspace', { headers: { authorization: 'Bearer nva_synthetic' } })).status, 401);
  const both = await request('/api/workspace', { headers: { authorization: 'Bearer nva_synthetic', cookie } });
  assert.equal(both.status, 200, 'with the feature off, a bearer beside a cookie is ignored as before');
  assert.equal((await request('/api/workspace/model', { method: 'PUT', body: {}, headers: { cookie, origin: 'http://localhost', 'content-type': 'application/json' } })).status, 403, 'CSRF still required');
  // The flag list is the Rust front's: Node refuses the read (503), so the OFF default is asserted against
  // the registry and the original Node implementation kept as the oracle instead of a Node reply.
  const flags = await request('/api/features', { headers: { cookie } });
  assert.equal(flags.status, 503);
  assert.equal(JSON.parse(flags.text).code, 'RUST_FEATURES_OWNED');
  const { REGISTRY } = require('./features.cjs');
  assert.notEqual(REGISTRY.nativeClientAuth.default, true);
  const legacy = require('../tests/server/oracles/features-legacy.cjs');
  assert.equal(legacy.createFeatures({ env: { TRUST_PROXY: 'true' }, store: { get: () => undefined, set() {} } }).flags().nativeClientAuth, false);
});
