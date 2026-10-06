'use strict';
// #928: completing an admin recovery revokes every other credential of the account in the same
// transaction: other recovery links, passkeys, app passwords (DAV) and Diary connector tokens.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createAuth } = require('./auth.cjs');
const { createCredentials } = require('./diary-connectors.cjs');

const ORIGIN = 'https://cowork.example.test';
const request = () => ({ headers: { origin: ORIGIN, 'user-agent': 'test' }, socket: { remoteAddress: '127.0.0.1' } });
const response = () => ({ headers: {}, setHeader(k, v) { this.headers[k] = v; } });

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-recovery-revoke-'));
  const auth = createAuth({ dataDir: root, publicOrigin: ORIGIN });
  t.after(() => { auth.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const admin = await auth.setup(request(), response(), { setupCode: fs.readFileSync(path.join(root, 'first-run-setup-code'), 'utf8').trim(), publicOrigin: ORIGIN, username: 'admin', password: 'synthetic admin password' });
  const adminId = admin.body.user.id;
  const member = await auth.acceptInvite(request(), response(), { token: auth.createInvite(adminId).token, username: 'member', password: 'synthetic member password', diaryEnabled: true });
  return { auth, adminId, memberId: member.body.user.id };
}

function seedPasskey(auth, userId, id) {
  auth.db.prepare('INSERT INTO passkeys(id,user_id,name,public_key,webauthn_user_id,counter,device_type,backed_up,transports,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(id, userId, 'Synthetic key', Buffer.from('pk'), 'w', 0, 'singleDevice', 0, JSON.stringify(['internal']), Date.now());
}

test('completing a recovery revokes passkeys, app passwords, connector tokens and other recovery links', async (t) => {
  const { auth, adminId, memberId } = await fixture(t);
  const connectors = createCredentials(auth);
  seedPasskey(auth, memberId, 'member-passkey');
  seedPasskey(auth, adminId, 'admin-passkey');
  const dav = await auth.appPasswords.create(memberId, { name: 'Synthetic phone', scope: 'lan' });
  const connector = connectors.create(memberId, 'Synthetic companion');
  assert.ok(await auth.appPasswords.verifyDav('member', dav.password, 'lan'), 'seeded app password works before recovery');
  assert.ok(connectors.verify(connector.token), 'seeded connector works before recovery');
  const first = auth.createRecovery(adminId, memberId);
  const second = auth.createRecovery(adminId, memberId);

  assert.equal(await auth.completeRecovery({ token: first.token, password: 'synthetic recovered password' }), true);

  assert.equal(await auth.appPasswords.verifyDav('member', dav.password, 'lan'), null, 'app password still signs in to DAV');
  assert.equal(connectors.verify(connector.token), null, 'Diary connector token still works');
  assert.deepEqual(auth.listPasskeys(memberId), [], 'passkey survived recovery');
  const options = await auth.authenticationOptions('member');
  assert.ok(!options.options.allowCredentials.some((c) => c.id === 'member-passkey'), 'revoked passkey is still offered');
  await assert.rejects(auth.authenticationVerify(request(), response(), { challengeToken: options.challengeToken, response: { id: 'member-passkey' } }), /authentication failed/);
  assert.equal(await auth.completeRecovery({ token: second.token, password: 'synthetic intruder password' }), false, 'a second recovery link still works');
  assert.equal((await auth.passwordLogin(request(), response(), { username: 'member', password: 'synthetic recovered password' })).status, 200);

  // Nobody else's credentials are touched.
  assert.equal(auth.listPasskeys(adminId).length, 1);
  const audit = auth.db.prepare("SELECT detail FROM audit_events WHERE action='recovery.complete'").get();
  assert.deepEqual(JSON.parse(audit.detail).revoked, { recoveries: 1, passkeys: 1, appPasswords: 1, diaryConnectors: 1 });
});

test('recovery works when the Diary connector table was never created', async (t) => {
  const { auth, adminId, memberId } = await fixture(t);
  assert.equal(auth.db.prepare("SELECT 1 FROM sqlite_master WHERE name='diary_connectors'").get(), undefined);
  const { token } = auth.createRecovery(adminId, memberId);
  assert.equal(await auth.completeRecovery({ token, password: 'synthetic recovered password' }), true);
});
