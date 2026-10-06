'use strict';
// #928 review: recovery must also beat credential requests already in flight. A passkey
// registration or app-password creation that is past its checks but still in its slow step when the
// recovery commits must not insert afterwards. Also: pending challenges die with the recovery, and
// the recovering admin's own session and app passwords are untouched.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

// Stand-in for the passkey library's verification step, so the test decides when it finishes.
const webauthnPath = require.resolve('@simplewebauthn/server');
const realWebauthn = require(webauthnPath);
let verifyRegistration = null;
require.cache[webauthnPath] = { id: webauthnPath, filename: webauthnPath, loaded: true,
  exports: { ...realWebauthn, verifyRegistrationResponse: (...args) => verifyRegistration(...args) } };
// Same for the password check, so a sign-in can be held while a recovery commits.
const argonPath = require.resolve('@node-rs/argon2');
const realArgon = require(argonPath);
let verifyPassword = null;
require.cache[argonPath] = { id: argonPath, filename: argonPath, loaded: true,
  exports: { ...realArgon, verify: (...args) => (verifyPassword || realArgon.verify)(...args) } };
let verifyAuthentication = null;
require.cache[webauthnPath].exports.verifyAuthenticationResponse = (...args) => verifyAuthentication(...args);
const { createAuth, createRateLimiter } = require('./auth.cjs');
const device = require('./device-auth.cjs');
const { createAppPasswords } = require('./app-passwords.cjs');

const ORIGIN = 'https://cowork.example.test';
const request = (cookie = '') => ({ headers: { origin: ORIGIN, 'user-agent': 'test', cookie }, socket: { remoteAddress: '127.0.0.1' } });
const response = () => ({ headers: {}, setHeader(k, v) { this.headers[k] = v; } });
const cookieOf = (res) => res.headers['Set-Cookie'][0].split(';')[0];
const gate = () => { let open; const opened = new Promise((resolve) => { open = resolve; }); return { opened, open }; };
const registered = (id) => ({ verified: true, registrationInfo: { credential: { id, publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ['internal'] }, credentialDeviceType: 'singleDevice', credentialBackedUp: false } });

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-recovery-race-'));
  const auth = createAuth({ dataDir: root, publicOrigin: ORIGIN });
  t.after(() => { auth.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const adminRes = response();
  const admin = await auth.setup(request(), adminRes, { setupCode: fs.readFileSync(path.join(root, 'first-run-setup-code'), 'utf8').trim(), publicOrigin: ORIGIN, username: 'admin', password: 'synthetic admin password' });
  const member = await auth.acceptInvite(request(), response(), { token: auth.createInvite(admin.body.user.id).token, username: 'member', password: 'synthetic member password' });
  return { auth, adminId: admin.body.user.id, adminCookie: cookieOf(adminRes), memberId: member.body.user.id };
}

test('passkey registration still verifying when recovery commits does not add the passkey', async (t) => {
  const { auth, adminId, memberId } = await fixture(t);
  // Control: without a recovery in between, the stubbed ceremony registers.
  verifyRegistration = async () => registered('control-key');
  const control = await auth.registrationOptions(memberId);
  assert.deepEqual(await auth.registrationVerify(memberId, { challengeToken: control.challengeToken, response: {} }), { verified: true });
  assert.equal(auth.listPasskeys(memberId).length, 1);

  const slow = gate(); let entered; const inside = new Promise((resolve) => { entered = resolve; });
  verifyRegistration = async () => { entered(); await slow.opened; return registered('intruder-key'); };
  const { challengeToken } = await auth.registrationOptions(memberId);
  const pending = auth.registrationVerify(memberId, { challengeToken, response: {} });
  await inside;
  assert.equal(await auth.completeRecovery({ token: auth.createRecovery(adminId, memberId).token, password: 'synthetic recovered password' }), true);
  slow.open();
  await assert.rejects(pending, /registration challenge expired/);
  assert.deepEqual(auth.listPasskeys(memberId), [], 'a passkey was added after the recovery');
});

test('app password still hashing when recovery commits is not created', async (t) => {
  const { auth, adminId, memberId } = await fixture(t);
  const slow = gate(); let entered; const inside = new Promise((resolve) => { entered = resolve; });
  const passwords = createAppPasswords({ db: auth.db, audit: auth.audit, rateLimited: () => false,
    hashPassword: async () => { entered(); await slow.opened; return '$argon2id$synthetic'; } });
  const pending = passwords.create(memberId, { name: 'Intruder laptop', scope: 'public' });
  await inside;
  assert.equal(await auth.completeRecovery({ token: auth.createRecovery(adminId, memberId).token, password: 'synthetic recovered password' }), true);
  slow.open();
  await assert.rejects(pending, /Account unavailable/);
  assert.deepEqual(auth.appPasswords.list(memberId), [], 'an app password was added after the recovery');
});

test('pending passkey challenges are refused after recovery', async (t) => {
  const { auth, adminId, memberId } = await fixture(t);
  verifyRegistration = async () => registered('late-key');
  const register = await auth.registrationOptions(memberId);
  auth.db.prepare('INSERT INTO passkeys(id,user_id,name,public_key,webauthn_user_id,counter,device_type,backed_up,transports,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run('member-passkey', memberId, 'Synthetic key', Buffer.from('pk'), 'w', 0, 'singleDevice', 0, JSON.stringify(['internal']), Date.now());
  const signIn = await auth.authenticationOptions('member');
  assert.equal(await auth.completeRecovery({ token: auth.createRecovery(adminId, memberId).token, password: 'synthetic recovered password' }), true);
  assert.equal(auth.db.prepare('SELECT count(*) AS n FROM challenges WHERE user_id=?').get(memberId).n, 0);
  await assert.rejects(auth.registrationVerify(memberId, { challengeToken: register.challengeToken, response: {} }), /registration challenge expired/);
  await assert.rejects(auth.authenticationVerify(request(), response(), { challengeToken: signIn.challengeToken, response: { id: 'member-passkey' } }), /authentication failed/);
  assert.deepEqual(auth.listPasskeys(memberId), []);
});

test("the recovering admin's own session and app passwords survive", async (t) => {
  const { auth, adminId, adminCookie, memberId } = await fixture(t);
  const adminDav = await auth.appPasswords.create(adminId, { name: 'Admin phone', scope: 'lan' });
  const memberDav = await auth.appPasswords.create(memberId, { name: 'Member phone', scope: 'lan' });
  const used = auth.createRecovery(adminId, memberId);
  assert.equal(await auth.completeRecovery({ token: auth.createRecovery(adminId, memberId).token, password: 'synthetic recovered password' }), true);
  assert.equal(auth.authenticate(request(adminCookie))?.user?.id, adminId, "the admin's session was signed out");
  assert.ok(await auth.appPasswords.verifyDav('admin', adminDav.password, 'lan'), "the admin's app password was revoked");
  assert.equal(await auth.appPasswords.verifyDav('member', memberDav.password, 'lan'), null);
  assert.equal(await auth.completeRecovery({ token: used.token, password: 'synthetic other password' }), false);
});

test('the audit counts only recovery links that still worked', async (t) => {
  const { auth, adminId, memberId } = await fixture(t);
  const spent = auth.createRecovery(adminId, memberId);
  assert.equal(await auth.completeRecovery({ token: spent.token, password: 'synthetic first password' }), true);
  auth.createRecovery(adminId, memberId);
  const expired = auth.createRecovery(adminId, memberId);
  auth.db.prepare('UPDATE recoveries SET expires_at=? WHERE token_hash=?').run(Date.now() - 1, require('./auth.cjs').digest(expired.token));
  assert.equal(await auth.completeRecovery({ token: auth.createRecovery(adminId, memberId).token, password: 'synthetic second password' }), true);
  const details = auth.db.prepare("SELECT detail FROM audit_events WHERE action='recovery.complete' ORDER BY id").all().map((r) => JSON.parse(r.detail).revoked.recoveries);
  assert.deepEqual(details, [0, 1]);
});

/** A stand-in check that stops until `open()`; `inside` resolves once the check has started. */
function held(result) {
  const slow = gate(); let entered; const inside = new Promise((resolve) => { entered = resolve; });
  return { inside, open: slow.open, check: async (...args) => { entered(); await slow.opened; return typeof result === 'function' ? result(...args) : result; } };
}
const sessionsOf = (auth, userId) => auth.db.prepare('SELECT count(*) AS n FROM sessions WHERE user_id=?').get(userId).n;

test('a password sign-in still checking the old password when recovery commits gets no session', async (t) => {
  const { auth, adminId, memberId } = await fixture(t);
  t.after(() => { verifyPassword = null; });
  const hold = held((hash, password) => realArgon.verify(hash, password));
  verifyPassword = hold.check;
  const pending = auth.passwordLogin(request(), response(), { username: 'member', password: 'synthetic member password' });
  await hold.inside;
  verifyPassword = null; // the recovery's own hashing is real
  assert.equal(await auth.completeRecovery({ token: auth.createRecovery(adminId, memberId).token, password: 'synthetic recovered password' }), true);
  hold.open();
  const out = await pending;
  assert.deepEqual([out.status, out.body], [401, { error: 'sign-in failed' }], 'answers exactly like a wrong password');
  assert.equal(sessionsOf(auth, memberId), 0, 'a session was issued with the revoked password');
  assert.equal((await auth.passwordLogin(request(), response(), { username: 'member', password: 'synthetic recovered password' })).status, 200);
});

test('a password sign-in still checking when the account is disabled gets no session', async (t) => {
  const { auth, adminId, memberId } = await fixture(t);
  t.after(() => { verifyPassword = null; });
  const hold = held((hash, password) => realArgon.verify(hash, password));
  verifyPassword = hold.check;
  const pending = auth.passwordLogin(request(), response(), { username: 'member', password: 'synthetic member password' });
  await hold.inside;
  auth.setDisabled(adminId, memberId, true);
  hold.open();
  assert.equal((await pending).status, 401);
  assert.equal(sessionsOf(auth, memberId), 0);
});

test('a passkey sign-in still verifying when recovery commits gets no session', async (t) => {
  const { auth, adminId, memberId } = await fixture(t);
  auth.db.prepare('INSERT INTO passkeys(id,user_id,name,public_key,webauthn_user_id,counter,device_type,backed_up,transports,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run('member-passkey', memberId, 'Synthetic key', Buffer.from('pk'), 'w', 0, 'singleDevice', 0, JSON.stringify(['internal']), Date.now());
  // Control: with nothing in between, the stubbed ceremony signs in.
  verifyAuthentication = async () => ({ verified: true, authenticationInfo: { newCounter: 1 } });
  const control = await auth.authenticationOptions('member');
  assert.equal((await auth.authenticationVerify(request(), response(), { challengeToken: control.challengeToken, response: { id: 'member-passkey' } })).user.id, memberId);
  auth.db.prepare('DELETE FROM sessions WHERE user_id=?').run(memberId);

  const hold = held({ verified: true, authenticationInfo: { newCounter: 2 } });
  verifyAuthentication = hold.check;
  const { challengeToken } = await auth.authenticationOptions('member');
  const pending = auth.authenticationVerify(request(), response(), { challengeToken, response: { id: 'member-passkey' } });
  await hold.inside;
  assert.equal(await auth.completeRecovery({ token: auth.createRecovery(adminId, memberId).token, password: 'synthetic recovered password' }), true);
  hold.open();
  await assert.rejects(pending, /^Error: authentication failed$/);
  assert.equal(sessionsOf(auth, memberId), 0, 'a session was issued with a revoked passkey');
});

test('a native-app approval sent before a recovery cannot become a grant after it (#933)', async (t) => {
  const { auth, adminId, memberId } = await fixture(t);
  const deviceAuth = device.createDeviceAuth({ db: auth.db, publicUser: auth.publicUser, rate: createRateLimiter(), clientAddress: (r) => r.socket.remoteAddress,
    audit: auth.audit, origin: () => ORIGIN, addressesTrusted: true });
  const memberRes = response();
  await auth.passwordLogin(request(), memberRes, { username: 'member', password: 'synthetic member password' });
  const session = auth.authenticate(request(cookieOf(memberRes))).session;
  // One request approved before the recovery and not redeemed yet; one approval still in flight.
  const early = deviceAuth.start(request(), { client_name: 'Early Mac' }).body;
  assert.equal(deviceAuth.decide(memberId, early.user_code, true, session.credential_epoch).status, 200);
  const late = deviceAuth.start(request(), { client_name: 'Late Mac' }).body;
  assert.equal(await auth.completeRecovery({ token: auth.createRecovery(adminId, memberId).token, password: 'synthetic recovered password' }), true);
  assert.equal(deviceAuth.decide(memberId, late.user_code, true, session.credential_epoch).status, 404, 'approval with a pre-recovery session went through');
  assert.equal(deviceAuth.decide(memberId, late.user_code, true, null).status, 404);
  for (const code of [early, late]) {
    assert.notEqual(deviceAuth.token(request(), { grant_type: device.DEVICE_GRANT_TYPE, device_code: code.device_code }).status, 200);
  }
  assert.equal(auth.db.prepare('SELECT count(*) AS n FROM device_grants WHERE user_id=?').get(memberId).n, 0);
});
