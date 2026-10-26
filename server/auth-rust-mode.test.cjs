'use strict';
// M3 (rust-auth.cjs) on createAuth's real database, permanent since sbstndalton/noevia#1071: the
// account tables are written by the Rust front only. Node's sign-in and account writers are gone,
// any write to those tables on its connection is refused (503), its request gate is read-only, the
// address follows settings, and the writers that stay Node's (account deletion, the DAV
// listener, revoking every device grant) still work. The accounts are written
// through a separate connection, as the front writes them. Synthetic accounts in a throwaway data dir.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');
const Database = require('better-sqlite3');
const { hash, Algorithm } = require('@node-rs/argon2');
const { createAuth, digest } = require('./auth.cjs');
const device = require('./device-auth.cjs');
const { seedAccount, seedDeviceToken } = require('../tests/server/seed-account.cjs');

const ORIGIN = 'https://noevia.example.test';
const req = (cookie, extra = {}) => ({ headers: { origin: ORIGIN, 'user-agent': 'test', ...(cookie ? { cookie } : {}), ...extra }, socket: { remoteAddress: '127.0.0.1' } });
const owned = (e) => e && e.status === 503 && e.code === 'RUST_AUTH_OWNED';
const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-rust-mode-'));
  // No option and no environment: the guard is always on (#1071).
  const auth = quiet(() => createAuth({ dataDir: dir, publicOrigin: ORIGIN }));
  const guard = auth.rustAuth;
  const owner = seedAccount(dir, { username: 'owner', publicOrigin: ORIGIN });
  seedAccount(dir, { username: 'member', role: 'member' });
  // An app password the front minted.
  const id = crypto.randomBytes(16).toString('hex');
  const app = { id, password: `nv_dav_${id}.${crypto.randomBytes(32).toString('base64url')}` };
  const front = new Database(path.join(dir, 'cowork.db'));
  try {
    front.prepare('INSERT INTO app_passwords(id,user_id,name,scope,password_hash,created_at) VALUES(?,?,?,?,?,?)')
      .run(id, owner.id, 'Phone', 'lan', await hash(app.password, { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 }), Date.now());
  } finally { front.close(); }
  const clock = { t: Date.now() };
  const deviceAuth = device.createDeviceAuth({ db: auth.db, audit: auth.audit, publicUser: auth.publicUser, now: () => clock.t, guard });
  t.after(() => { auth.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, auth, guard, deviceAuth, clock, session: owner.session, userId: owner.id, app };
}

const row = (db, sql, ...a) => db.prepare(sql).get(...a);

test('the request gate reads and never writes', async (t) => {
  const f = await fixture(t);
  const id = digest(f.session);
  f.guard.exempt(() => f.auth.db.prepare('UPDATE sessions SET last_seen_at=? WHERE id_hash=?').run(Date.now() - 60_000, id));
  const seen = row(f.auth.db, 'SELECT last_seen_at FROM sessions WHERE id_hash=?', id).last_seen_at;
  const authn = f.auth.authenticate(req(`cowork_session=${f.session}`));
  assert.equal(authn.user.username, 'owner');
  assert.equal(row(f.auth.db, 'SELECT last_seen_at FROM sessions WHERE id_hash=?', id).last_seen_at, seen, 'last_seen_at is the front\'s to move');
  // A rejected session stays for the front to delete; Node still refuses it.
  f.guard.exempt(() => f.auth.db.prepare('UPDATE sessions SET expires_at=1 WHERE id_hash=?').run(id));
  assert.equal(f.auth.authenticate(req(`cowork_session=${f.session}`)), null);
  assert.ok(row(f.auth.db, 'SELECT 1 AS x FROM sessions WHERE id_hash=?', id));
  assert.equal(f.auth.authenticate(req('cowork_session=unknown-synthetic')), null);
});

test('sign-in and account writers are gone, and any write to the account tables is refused with 503', async (t) => {
  const f = await fixture(t);
  assert.equal(f.guard.enabled, true);
  for (const name of ['setup', 'passwordLogin', 'logout', 'registrationOptions', 'registrationVerify', 'authenticationOptions', 'authenticationVerify',
    'listPasskeys', 'listSessions', 'revokeSession', 'deletePasskey', 'renamePasskey', 'createInvite', 'acceptInvite', 'setDisabled',
    'createRecovery', 'completeRecovery', 'getAppearance', 'setAppearance', 'updateProfile', 'setDiaryEnabled', 'markOnboarded', 'issueSession']) {
    assert.equal(f.auth[name], undefined, `auth.${name} is the Rust front's`);
  }
  assert.equal(f.auth.appPasswords.create, undefined);
  assert.equal(f.auth.appPasswords.revoke, undefined);
  for (const name of ['start', 'token', 'lookup', 'decide', 'list', 'revoke']) assert.equal(f.deviceAuth[name], undefined, `deviceAuth.${name}`);
  for (const sql of [
    "UPDATE users SET display_name='Renamed'", 'DELETE FROM sessions', "INSERT INTO invitations(token_hash,created_by,role,expires_at,created_at) VALUES('t','x','member',1,1)",
    'UPDATE user_features SET diary_enabled=1', 'DELETE FROM app_passwords', 'DELETE FROM device_grants', "INSERT OR REPLACE INTO settings(key,value) VALUES('public_origin','x')",
  ]) assert.throws(() => f.auth.db.prepare(sql).run(), owned, sql);
  // Nothing reached the database.
  assert.equal(row(f.auth.db, 'SELECT count(*) AS n FROM sessions').n, 2);
  assert.equal(row(f.auth.db, "SELECT display_name AS d FROM users WHERE id=?", f.userId).d, 'owner');
  // The shared audit log is still appended to.
  f.auth.audit('tool.write', f.userId, f.userId, { tool: 'synthetic' });
  assert.equal(row(f.auth.db, "SELECT count(*) AS n FROM audit_events WHERE action='tool.write'").n, 1);
});

test('the address follows settings the Rust front writes', async (t) => {
  const f = await fixture(t);
  assert.equal(f.auth.origin, ORIGIN);
  const NEXT = 'https://next.example.test';
  const front = new Database(path.join(f.dir, 'cowork.db'));
  try { front.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('public_origin_admin',?)").run(NEXT); } finally { front.close(); }
  assert.equal(f.auth.origin, NEXT);
  assert.equal(f.auth.rpId, 'next.example.test');
  assert.equal(f.auth.originSource, 'settings');
  assert.equal(f.auth.originValid(req(null, { origin: NEXT })), true);
  assert.equal(f.auth.originValid(req(null, { origin: ORIGIN })), false);
});

test('the writers that stay Node\'s still work', async (t) => {
  const f = await fixture(t);
  // The DAV listener's last_used_at.
  const dav = await f.auth.appPasswords.verifyDav('owner', f.app.password, 'lan');
  assert.equal(dav.credentialId, f.app.id);
  assert.ok(row(f.auth.db, 'SELECT last_used_at FROM app_passwords WHERE id=?', f.app.id).last_used_at > 0);
  // Switching native-client sign-in off revokes every grant.
  const grant = seedDeviceToken(f.dir, f.userId, { clientName: 'Mac', now: 1 });
  f.clock.t = 2;
  const authed = f.deviceAuth.authenticate({ headers: { authorization: `Bearer ${grant.access}` } });
  assert.equal(authed.device.id, grant.grantId);
  assert.equal(row(f.auth.db, 'SELECT last_used_at AS u FROM device_grants WHERE id=?', grant.grantId).u, 1, 'the grant touch is the front\'s');
  assert.equal(f.deviceAuth.revokeAll(f.userId, 'feature-off'), 1);
  assert.equal(row(f.auth.db, 'SELECT count(*) AS n FROM device_tokens').n, 0);
  // Deleting an account (and its cleanup) is Node's.
  const member = row(f.auth.db, "SELECT id FROM users WHERE username='member'").id;
  assert.equal(f.auth.deleteUser(f.userId, member, 'member'), true);
  assert.equal(row(f.auth.db, 'SELECT count(*) AS n FROM users').n, 1);
  // And the guard is back on afterwards.
  assert.throws(() => f.auth.db.prepare('DELETE FROM users').run(), owned);
});
