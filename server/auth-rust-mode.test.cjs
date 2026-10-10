'use strict';
// M3 (rust-auth.cjs) on createAuth's real database: with NOEVIA_RUST_AUTH on, the account tables
// are written by the Rust front only. Node's sign-in and account writers are refused (503), its
// request gate is read-only, the address follows settings, and the writers that stay Node's
// (account deletion, Settings -> Web address, the DAV listener, revoking every device grant) still
// work. Synthetic accounts in a throwaway data dir.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createAuth, createRateLimiter, digest } = require('./auth.cjs');
const device = require('./device-auth.cjs');
const { createRustAuthGuard } = require('./rust-auth.cjs');

const ORIGIN = 'https://noevia.example.test';
const PASSWORD = 'synthetic rust-mode password';
const req = (cookie, extra = {}) => ({ headers: { origin: ORIGIN, 'user-agent': 'test', ...(cookie ? { cookie } : {}), ...extra }, socket: { remoteAddress: '127.0.0.1' } });
const res = () => ({ headers: {}, setHeader(k, v) { this.headers[k] = v; } });
const owned = (e) => e && e.status === 503 && e.code === 'RUST_AUTH_OWNED';
const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-rust-mode-'));
  // Node as it runs today sets the account up; then it restarts with the switch on.
  const before = quiet(() => createAuth({ dataDir: dir, publicOrigin: ORIGIN }));
  const setupCode = fs.readFileSync(path.join(dir, 'first-run-setup-code'), 'utf8').trim();
  const setupRes = res();
  const setup = await before.setup(req(), setupRes, { setupCode, publicOrigin: ORIGIN, username: 'owner', password: PASSWORD });
  assert.equal(setup.status, 201);
  const session = /cowork_session=([^;]+)/.exec(setupRes.headers['Set-Cookie'][0])[1];
  const userId = setup.body.user.id;
  const app = await before.appPasswords.create(userId, { name: 'Phone', scope: 'lan' });
  const invite = before.createInvite(userId, 'member');
  await before.acceptInvite(req(), res(), { token: invite.token, username: 'member', password: PASSWORD });
  before.db.close();

  const guard = createRustAuthGuard({ enabled: true });
  const auth = quiet(() => createAuth({ dataDir: dir, publicOrigin: ORIGIN, rustAuth: guard }));
  const clock = { t: Date.now() };
  const deviceAuth = device.createDeviceAuth({ db: auth.db, audit: auth.audit, publicUser: auth.publicUser, rate: createRateLimiter(),
    clientAddress: () => '127.0.0.1', origin: () => auth.origin, now: () => clock.t, addressesTrusted: true, guard });
  t.after(() => { auth.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, auth, guard, deviceAuth, clock, session, userId, app };
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

test('sign-in and account writers are refused with 503', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.auth.passwordLogin(req(), res(), { username: 'owner', password: PASSWORD }), owned);
  // Logout clears the cookies even though the guarded session delete throws, and the row stays.
  const out = res();
  const originalWarn = console.warn;
  console.warn = () => {};
  try { assert.equal(f.auth.logout(req(`cowork_session=${f.session}`), out, null).status, 200); } finally { console.warn = originalWarn; }
  assert.match(out.headers['Set-Cookie'].join('\n'), /cowork_session=; .*Max-Age=0[\s\S]*cowork_csrf=; .*Max-Age=0/);
  assert.ok(row(f.auth.db, 'SELECT 1 AS x FROM sessions WHERE id_hash=?', digest(f.session)));
  assert.throws(() => f.auth.createInvite(f.userId, 'member'), owned);
  assert.throws(() => f.auth.createRecovery(f.userId, f.userId), owned);
  assert.throws(() => f.auth.updateProfile(f.userId, 'Renamed'), owned);
  assert.throws(() => f.auth.setDiaryEnabled(f.userId, true), owned);
  assert.throws(() => f.auth.markOnboarded(f.userId), owned);
  assert.throws(() => f.auth.setAppearance(f.userId, { theme: 'dark', light: 'warm', dark: 'cool' }), owned);
  assert.throws(() => f.auth.revokeSession(f.userId, digest(f.session)), owned);
  const member = row(f.auth.db, "SELECT id FROM users WHERE username='member'").id;
  assert.throws(() => f.auth.setDisabled(f.userId, member, true), owned);
  await assert.rejects(f.auth.appPasswords.create(f.userId, { name: 'Laptop', scope: 'lan' }), owned);
  assert.throws(() => f.auth.appPasswords.revoke(f.userId, f.app.id), owned);
  await assert.rejects(f.auth.registrationOptions(f.userId), owned);
  await assert.rejects(f.auth.authenticationOptions('owner', req()), owned);
  assert.throws(() => f.deviceAuth.start(req(), { client_name: 'Mac' }), owned);
  // Nothing reached the database.
  assert.equal(row(f.auth.db, 'SELECT count(*) AS n FROM sessions').n, 2);
  assert.equal(row(f.auth.db, "SELECT display_name AS d FROM users WHERE id=?", f.userId).d, 'owner');
  assert.equal(row(f.auth.db, 'SELECT count(*) AS n FROM invitations WHERE used_at IS NULL').n, 0);
  // The shared audit log is still appended to.
  f.auth.audit('tool.write', f.userId, f.userId, { tool: 'synthetic' });
  assert.equal(row(f.auth.db, "SELECT count(*) AS n FROM audit_events WHERE action='tool.write'").n, 1);
});

test('the address follows settings the Rust front writes', async (t) => {
  const f = await fixture(t);
  assert.equal(f.auth.origin, ORIGIN);
  const NEXT = 'https://next.example.test';
  f.guard.exempt(() => f.auth.db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('public_origin_admin',?)").run(NEXT));
  assert.equal(f.auth.origin, NEXT);
  assert.equal(f.auth.rpId, 'next.example.test');
  assert.equal(f.auth.originSource, 'settings');
  assert.equal(f.auth.originValid(req(null, { origin: NEXT })), true);
  assert.equal(f.auth.originValid(req(null, { origin: ORIGIN })), false);
});

test('the writers that stay Node\'s still work', async (t) => {
  const f = await fixture(t);
  // Settings -> Web address.
  assert.equal(f.auth.changeOrigin('https://renamed.example.test', f.userId), null);
  assert.equal(f.auth.origin, 'https://renamed.example.test');
  assert.deepEqual(f.auth.previousOrigins, [ORIGIN]);
  assert.equal(f.auth.originValid(req(null, { origin: ORIGIN })), true);
  // The DAV listener's last_used_at.
  const dav = await f.auth.appPasswords.verifyDav('owner', f.app.password, 'lan');
  assert.equal(dav.credentialId, f.app.id);
  assert.ok(row(f.auth.db, 'SELECT last_used_at FROM app_passwords WHERE id=?', f.app.id).last_used_at > 0);
  // Switching native-client sign-in off revokes every grant.
  f.guard.exempt(() => {
    f.auth.db.prepare("INSERT INTO device_grants VALUES('g1',?,'Mac',1,1,?,'ip','ua')").run(f.userId, Date.now() + 86_400_000);
    f.auth.db.prepare("INSERT INTO device_tokens VALUES(?,'g1','access',1,?,NULL,NULL)").run(digest('nva_synthetic'), Date.now() + 3_600_000);
  });
  const authed = f.deviceAuth.authenticate({ headers: { authorization: 'Bearer nva_synthetic' } });
  assert.equal(authed.device.id, 'g1');
  assert.equal(row(f.auth.db, "SELECT last_used_at AS u FROM device_grants WHERE id='g1'").u, 1, 'the grant touch is the front\'s');
  assert.equal(f.deviceAuth.revokeAll(f.userId, 'feature-off'), 1);
  assert.equal(row(f.auth.db, 'SELECT count(*) AS n FROM device_tokens').n, 0);
  // Deleting an account (and its cleanup) is Node's.
  const member = row(f.auth.db, "SELECT id FROM users WHERE username='member'").id;
  assert.equal(f.auth.deleteUser(f.userId, member, 'member'), true);
  assert.equal(row(f.auth.db, 'SELECT count(*) AS n FROM users').n, 1);
  // And the guard is back on afterwards.
  assert.throws(() => f.auth.db.prepare('DELETE FROM users').run(), owned);
});
