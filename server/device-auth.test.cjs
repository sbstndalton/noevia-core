'use strict';

// device-auth.cjs: what stays Node's of native-client sign-in once the device flow is the Rust
// front's (sbstndalton/noevia#1071): reading a device access token (read-only), revoking every
// grant when the feature is switched off, and the browser-only path rules. The grants are written
// through a separate connection, as the front writes them. Synthetic accounts in a throwaway auth
// database.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const { createAuth } = require('./auth.cjs');
const device = require('./device-auth.cjs');
const { seedAccount, seedDeviceToken } = require('../tests/server/seed-account.cjs');

const ORIGIN = 'https://noevia.example.test';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-device-unit-'));
  const warn = console.warn;
  console.warn = () => {}; // the first-run setup code is synthetic; keep it out of the output
  let auth;
  try { auth = createAuth({ dataDir: root, publicOrigin: ORIGIN }); } finally { console.warn = warn; }
  t.after(() => { auth.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const clock = { t: Date.now() };
  const audits = [];
  const deviceAuth = device.createDeviceAuth({
    db: auth.db, publicUser: auth.publicUser, guard: auth.rustAuth, now: () => clock.t,
    audit: (...a) => { audits.push(a); auth.audit(...a); },
  });
  const userId = seedAccount(root, { username: 'owner' }).id;
  return { root, auth, deviceAuth, clock, audits, userId };
}

const bearerReq = (token) => ({ headers: { authorization: `Bearer ${token}` } });

test('a device access token authenticates as its account, as a member, and nothing is written', (t) => {
  const f = fixture(t);
  const tokens = seedDeviceToken(f.root, f.userId, { clientName: 'Unit Mac', now: f.clock.t });
  const before = f.auth.db.prepare('SELECT last_used_at FROM device_grants WHERE id=?').get(tokens.grantId).last_used_at;
  f.clock.t += 10 * 60 * 1000;
  const authn = f.deviceAuth.authenticate(bearerReq(tokens.access));
  assert.equal(authn.user.id, f.userId);
  assert.equal(authn.user.role, 'member', 'never an administrator');
  assert.equal(authn.accountRole, 'admin');
  assert.deepEqual(authn.device, { id: tokens.grantId, clientName: 'Unit Mac', expiresAt: f.auth.db.prepare('SELECT expires_at FROM device_grants WHERE id=?').get(tokens.grantId).expires_at });
  assert.equal(f.auth.db.prepare('SELECT last_used_at FROM device_grants WHERE id=?').get(tokens.grantId).last_used_at, before,
    'the front touches last_used_at before it proxies (server-auth upkeep); Node only reads');
  // A refresh token, an unknown token and an expired one are not access tokens.
  assert.equal(f.deviceAuth.authenticate(bearerReq(tokens.refresh)), null);
  assert.equal(f.deviceAuth.authenticate(bearerReq('nva_not-a-real-token')), null);
  f.clock.t += 2 * 60 * 60 * 1000;
  assert.equal(f.deviceAuth.authenticate(bearerReq(tokens.access)), null, 'an access token lasts an hour');
});

test('a disabled account\'s device token is refused', (t) => {
  const f = fixture(t);
  const tokens = seedDeviceToken(f.root, f.userId, { now: f.clock.t });
  const db = new Database(path.join(f.root, 'cowork.db'));
  try { db.prepare('UPDATE users SET disabled_at=? WHERE id=?').run(f.clock.t, f.userId); } finally { db.close(); }
  assert.equal(f.deviceAuth.authenticate(bearerReq(tokens.access)), null);
});

test('F4: revokeAll deletes every grant and pending request and audits each account once (a rust-auth.cjs exemption)', (t) => {
  const f = fixture(t);
  const a = seedDeviceToken(f.root, f.userId, { clientName: 'One', now: f.clock.t });
  const b = seedDeviceToken(f.root, f.userId, { clientName: 'Two', now: f.clock.t });
  const db = new Database(path.join(f.root, 'cowork.db'));
  try {
    db.prepare(`INSERT INTO device_authorizations(device_code_hash,user_code_hash,client_name,ip,user_agent,created_at,expires_at,interval_ms,status,user_id)
      VALUES('synthetic-device-code','synthetic-user-code','Approved','127.0.0.1','ua',?,?,5000,'approved',?)`).run(f.clock.t, f.clock.t + 600000, f.userId);
  } finally { db.close(); }
  // Outside the exemption, Node's connection refuses the same delete.
  assert.throws(() => f.auth.db.prepare('DELETE FROM device_grants').run(), (e) => e.code === 'RUST_AUTH_OWNED');
  assert.equal(f.deviceAuth.revokeAll('admin-actor', 'feature-off'), 2);
  assert.equal(f.deviceAuth.authenticate(bearerReq(a.access)), null);
  assert.equal(f.deviceAuth.authenticate(bearerReq(b.access)), null);
  assert.equal(f.auth.db.prepare('SELECT count(*) AS n FROM device_tokens').get().n, 0);
  assert.equal(f.auth.db.prepare('SELECT count(*) AS n FROM device_authorizations').get().n, 0, 'an approved code cannot be redeemed after the switch-off');
  const revokes = f.audits.filter(([action]) => action === 'device.revoke_all');
  assert.deepEqual(revokes.map(([, actor, target, detail]) => [actor, target, detail.count, detail.reason]), [['admin-actor', f.userId, 2, 'feature-off']]);
  assert.equal(f.deviceAuth.revokeAll('admin-actor', 'feature-off'), 0);
});

test('N3: native-app sign-in cannot be enabled without TRUST_PROXY', () => {
  const { createFeatures } = require('./features.cjs');
  const store = () => { const m = new Map(); return { get: (k) => m.get(k), set: (k, v) => m.set(k, v) }; };
  const off = createFeatures({ env: { NOEVIA_FEATURE_NATIVE_CLIENT_AUTH: 'true' }, store: store() });
  assert.equal(off.enabled('nativeClientAuth'), false, 'even the env var cannot switch it on');
  assert.equal(off.flags().nativeClientAuth, false);
  assert.match(off.describe().find((f) => f.name === 'nativeClientAuth').unavailable, /Needs TRUST_PROXY on so sign-in limits can tell clients apart/);
  const admin = createFeatures({ env: {}, store: store() });
  assert.throws(() => admin.set('nativeClientAuth', true, 'admin'), (e) => e.status === 409 && /TRUST_PROXY/.test(e.message));
  assert.equal(createFeatures({ env: { NOEVIA_FEATURE_NATIVE_CLIENT_AUTH: 'true', TRUST_PROXY: 'true' }, store: store() }).enabled('nativeClientAuth'), true);
});

test('browser-only paths match on segment boundaries, not on look-alike prefixes', () => {
  assert.equal(device.browserOnly('/api/admin'), true);
  assert.equal(device.browserOnly('/api/admin/users/x/disabled', 'PUT'), true);
  assert.equal(device.browserOnly('/api/administrator'), false);
  assert.equal(device.browserOnly('/api/profile'), true);
  assert.equal(device.browserOnly('/api/profile/appearance'), false);
  assert.equal(device.browserOnly('/api/integrations/storage', 'GET'), false);
  assert.equal(device.browserOnly('/api/integrations/storage', 'PUT'), true);
  assert.equal(device.browserOnly('/api/integrations/storage/files/a.md', 'GET'), false);
  assert.equal(device.browserOnly('/api/workspace'), false);
  assert.equal(device.browserOnly('/api/chat', 'POST'), false);
  assert.equal(device.browserOnly('/api/tool-approvals/abc', 'POST'), false, 'a device answers its own write approvals');
});

test('the request authenticator is exactly auth.cjs while the feature is off', (t) => {
  const f = fixture(t);
  const tokens = seedDeviceToken(f.root, f.userId, { clientName: 'Unit Mac', now: f.clock.t });
  let on = false;
  const calls = [];
  const fakeAuth = { authenticate: (r) => { calls.push(r); return null; }, csrfValid: () => false };
  const gate = device.createRequestAuth({ enabled: () => on, deviceAuth: f.deviceAuth, authService: fakeAuth });
  assert.equal(gate.authenticate(bearerReq(tokens.access)), null);
  assert.equal(calls.length, 1, 'with the flag off, the bearer goes to auth.cjs untouched');
  on = true;
  const authn = gate.authenticate(bearerReq(tokens.access));
  assert.equal(authn.device.clientName, 'Unit Mac');
  assert.equal(calls.length, 1);
  assert.equal(gate.csrfValid(bearerReq(tokens.access), authn), true);
  assert.equal(gate.csrfValid({ headers: { ...bearerReq(tokens.access).headers, cookie: 'cowork_session=x' } }, authn), false);
  assert.equal(gate.authenticate({ headers: { ...bearerReq(tokens.access).headers, cookie: 'cowork_session=x' } }), null);
  assert.equal(gate.browserOnly(authn, '/api/admin/users', 'GET'), true);
  assert.equal(gate.browserOnly({ user: {}, session: {} }, '/api/admin/users', 'GET'), false);
  // Turning the feature off stops every device token at once.
  on = false;
  assert.equal(gate.authenticate(bearerReq(tokens.access)), null);
});
