'use strict';

// Native-client sign-in (#555) with the nativeClientAuth feature OFF (its default): every
// endpoint and the approval page answer 404 through the real router, and nothing else changes.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const test = require('node:test');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-device-off-'));
process.env.UI_DATA_DIR = dataDir;
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

test('with the feature off, every device endpoint and the approval page are 404, signed in or not', async () => {
  const setupCode = fs.readFileSync(path.join(dataDir, 'first-run-setup-code'), 'utf8').trim();
  const setup = await request('/api/setup/complete', { method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json' },
    body: { setupCode, publicOrigin: 'http://localhost', username: 'offqa', password: 'synthetic flag-off password' } });
  assert.equal(setup.status, 201);
  const cookies = setup.headers['set-cookie'].map((c) => c.split(';')[0]);
  const cookie = cookies.join('; ');
  const csrf = decodeURIComponent(cookies.find((c) => c.startsWith('cowork_csrf=')).split('=').slice(1).join('='));
  const signedIn = { cookie, origin: 'http://localhost', 'x-csrf-token': csrf, 'content-type': 'application/json' };

  const routes = [
    ['POST', '/api/auth/device/code', { client_name: 'x' }],
    ['POST', '/api/auth/device/token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: 'x' }],
    ['POST', '/api/auth/device/lookup', { user_code: 'BCDF-GHJK' }],
    ['POST', '/api/auth/device/approve', { user_code: 'BCDF-GHJK', approve: true }],
    ['GET', '/api/auth/devices'],
    ['DELETE', `/api/auth/devices/${'a'.repeat(32)}`],
    ['GET', '/device'],
  ];
  for (const headers of [{}, signedIn]) {
    for (const [method, url, body] of routes) {
      const r = await request(url, { method, body, headers });
      assert.equal(r.status, 404, `${method} ${url} (${headers.cookie ? 'signed in' : 'signed out'}) -> ${r.status}`);
    }
  }
  // A device-shaped bearer means nothing; cookie sessions and CSRF behave exactly as before.
  assert.equal((await request('/api/workspace', { headers: { authorization: 'Bearer nva_synthetic' } })).status, 401);
  const both = await request('/api/workspace', { headers: { authorization: 'Bearer nva_synthetic', cookie } });
  assert.equal(both.status, 200, 'with the feature off, a bearer beside a cookie is ignored as before');
  assert.equal((await request('/api/auth/session', { headers: { cookie } })).status, 200);
  assert.equal((await request('/api/freechats', { method: 'POST', body: { chats: [] }, headers: { cookie, origin: 'http://localhost', 'content-type': 'application/json' } })).status, 403, 'CSRF still required');
  const flags = JSON.parse((await request('/api/features', { headers: { cookie } })).text).flags;
  assert.equal(flags.nativeClientAuth, false);
});
