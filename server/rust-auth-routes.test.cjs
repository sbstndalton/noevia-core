'use strict';
// sbstndalton/noevia#1071 through the real router (index.cjs handleRequest): sign-in and the account
// are the Rust front's permanently. Whatever the environment says (no switch, the retired switch off,
// or NOEVIA_FRONT=node), a request for one of those routes that reaches Node bypassed the front and
// is refused with 503 before anything else runs, signed in or not; the account routes Node still
// answers keep working, and nothing is written to the account tables. Synthetic accounts only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const test = require('node:test');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-rust-auth-routes-'));
process.env.UI_DATA_DIR = dataDir;
// #1071: Node saves projects.json / free-chats.json only through the Rust project store.
require('../tests/server/project-store-server.cjs').installProjectStore(dataDir);
process.env.PUBLIC_ORIGIN = 'http://localhost';
process.env.LEGACY_AUTH_COMPAT = 'false';
// The retired switch, explicitly off, and the Node front selector: neither hands sign-in back.
process.env.NOEVIA_RUST_AUTH = '0';
process.env.NOEVIA_FRONT = 'node';

const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };
const { handleRequest } = quiet(() => require('./index.cjs'));
const { ROUTE_REFUSAL } = require('./rust-auth.cjs');
const { seedAccount } = require('../tests/server/seed-account.cjs');

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

async function request(url, { method = 'GET', headers = {}, body } = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  const req = Readable.from(payload ? [payload] : []);
  Object.assign(req, { url, method, headers: { host: 'localhost', ...(payload ? { 'content-type': 'application/json' } : {}), ...headers }, socket: { remoteAddress: '127.0.0.1' } });
  const chunks = []; const out = {};
  const res = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  res.statusCode = 200; res.headersSent = false;
  res.setHeader = (k, v) => { out[k.toLowerCase()] = v; };
  res.writeHead = (s, h = {}) => { res.statusCode = s; res.headersSent = true; for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v; return res; };
  const done = new Promise((resolve) => res.once('finish', resolve));
  await handleRequest(req, res); await done;
  const text = Buffer.concat(chunks).toString('utf8');
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.statusCode, json, headers: out };
}

function counts() {
  const db = new (require('better-sqlite3'))(path.join(dataDir, 'cowork.db'), { readonly: true });
  try {
    return Object.fromEntries(['users', 'sessions', 'invitations', 'recoveries', 'passkeys', 'challenges', 'app_passwords', 'user_appearance']
      .map((t) => [t, db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n]));
  } finally { db.close(); }
}

test('every sign-in and account route is refused, signed in or not, and nothing is written', async () => {
  const admin = seedAccount(dataDir, { username: 'routes-admin', publicOrigin: 'http://localhost' });
  const signedIn = admin.headers('http://localhost');
  const before = counts();
  const routes = [
    ['GET', '/api/setup/status'],
    ['POST', '/api/setup/complete', { setupCode: 'x', username: 'synthetic', password: 'synthetic password' }],
    ['POST', '/api/auth/login/password', { username: 'routes-admin', password: 'synthetic password' }],
    ['POST', '/api/auth/login/passkey/options', { username: 'routes-admin' }],
    ['POST', '/api/auth/login/passkey/verify', {}],
    ['POST', '/api/auth/invitations/accept', { token: 'x' }],
    ['POST', '/api/auth/recovery/complete', { token: 'x', password: 'y' }],
    ['GET', '/api/auth/session'],
    ['POST', '/api/auth/logout', {}],
    ['GET', '/api/profile'],
    ['PATCH', '/api/profile', { displayName: 'Renamed' }],
    ['GET', '/api/profile/appearance'],
    ['PUT', '/api/profile/appearance', { theme: 'dark' }],
    ['PUT', '/api/profile/features', { diaryEnabled: true }],
    ['POST', '/api/profile/onboarding', {}],
    ['GET', '/api/profile/sharing'],
    ['PUT', '/api/profile/sharing', { scope: 'off' }],
    ['GET', '/api/profile/app-passwords'],
    ['POST', '/api/profile/app-passwords', { name: 'Phone', scope: 'lan' }],
    ['DELETE', `/api/profile/app-passwords/${'a'.repeat(32)}`],
    ['POST', '/api/auth/passkeys/register/options', {}],
    ['PATCH', '/api/auth/passkeys/k1', { name: 'x' }],
    ['DELETE', '/api/auth/passkeys/k1'],
    ['DELETE', '/api/auth/sessions/s1'],
    ['GET', '/api/account/instructions'],
    ['PUT', '/api/account/memory', { memories: [] }],
    ['PUT', '/api/account/preferences', { sendKey: 'enter' }],
    ['GET', '/api/admin/users'],
    ['POST', '/api/admin/invitations', { role: 'member' }],
    ['PUT', `/api/admin/users/${admin.id}/disabled`, { disabled: true }],
    ['POST', `/api/admin/users/${admin.id}/recovery`],
  ];
  for (const headers of [{ origin: 'http://localhost' }, signedIn]) {
    for (const [method, url, body] of routes) {
      const r = await request(url, { method, body, headers });
      assert.equal(r.status, 503, `${method} ${url} (${headers.cookie ? 'signed in' : 'signed out'}) -> ${r.status}`);
      assert.deepEqual(r.json, ROUTE_REFUSAL, `${method} ${url}`);
    }
  }
  assert.deepEqual(counts(), before, 'no account table changed');
});

test('the account routes Node still answers keep working', async () => {
  const admin = seedAccount(dataDir, { username: 'routes-owner', publicOrigin: 'http://localhost' });
  const member = seedAccount(dataDir, { username: 'routes-member', role: 'member' });
  // sbstndalton/noevia#1071: the retention preview (GET) is the Rust front's; its PUT is Node's.
  const preview = await request('/api/account/retention', { headers: { cookie: admin.cookie } });
  assert.equal(preview.status, 503);
  assert.deepEqual(preview.json, ROUTE_REFUSAL);
  assert.equal((await request('/api/admin/web-address', { headers: { cookie: admin.cookie } })).status, 200);
  assert.equal((await request('/api/workspace', { headers: { cookie: admin.cookie } })).status, 200, 'the seeded session signs in (read-only gate)');
  assert.equal((await request('/api/workspace')).status, 401);
  // Deleting an account stays Node's (its clean-up spans Node's own stores).
  const removed = await request(`/api/admin/users/${member.id}`, { method: 'DELETE', body: { username: 'routes-member' }, headers: admin.headers('http://localhost') });
  assert.equal(removed.status, 200, JSON.stringify(removed.json));
  assert.equal((await request('/api/workspace', { headers: { cookie: member.cookie } })).status, 401, 'the deleted account is signed out');
  // A member is still refused /api/admin/* before its routes are looked at.
  const other = seedAccount(dataDir, { username: 'routes-member-two', role: 'member' });
  assert.equal((await request('/api/admin/web-address', { headers: { cookie: other.cookie } })).status, 403);
});
