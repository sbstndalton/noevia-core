'use strict';
// #863: the account's last way to sign in is never deleted. Synthetic users only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createAuth } = require('./auth.cjs');

const request = () => ({ headers: { origin: 'https://cowork.example.test', 'user-agent': 'test' }, socket: { remoteAddress: '127.0.0.1' } });
const response = () => ({ headers: {}, setHeader(k, v) { this.headers[k] = v; } });

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-lastcred-'));
  const auth = createAuth({ dataDir: root, publicOrigin: 'https://cowork.example.test' });
  t.after(() => { auth.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await auth.setup(request(), response(), { setupCode: fs.readFileSync(path.join(root, 'first-run-setup-code'), 'utf8').trim(), publicOrigin: 'https://cowork.example.test', username: 'owner', password: 'synthetic last credential password' });
  const userId = auth.listUsers()[0].id;
  const add = (id) => auth.db.prepare('INSERT INTO passkeys(id,user_id,name,public_key,webauthn_user_id,counter,device_type,backed_up,transports,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(id, userId, `Synthetic ${id}`, Buffer.from('pk'), 'w', 0, 'singleDevice', 0, '[]', Date.now());
  const count = () => auth.db.prepare('SELECT count(*) AS n FROM passkeys WHERE user_id=?').get(userId).n;
  return { auth, userId, add, count };
}

test('an account with a password may remove its only passkey', async (t) => {
  const { auth, userId, add, count } = await fixture(t);
  add('pk-a');
  assert.equal(auth.deletePasskey(userId, 'pk-a'), true);
  assert.equal(count(), 0);
});

test('a password-less account cannot remove its last passkey, but can remove one of several', async (t) => {
  const { auth, userId, add, count } = await fixture(t);
  auth.db.prepare("UPDATE users SET password_hash='' WHERE id=?").run(userId);
  add('pk-a');
  assert.throws(() => auth.deletePasskey(userId, 'pk-a'), (e) => e.code === 'LAST_CREDENTIAL' && /only way to sign in/.test(e.message));
  assert.equal(count(), 1, 'the refused delete removed nothing');
  add('pk-b');
  assert.equal(auth.deletePasskey(userId, 'pk-a'), true);
  assert.equal(count(), 1);
  assert.throws(() => auth.deletePasskey(userId, 'pk-b'), (e) => e.code === 'LAST_CREDENTIAL', 'the survivor is now the last one');
  assert.equal(auth.deletePasskey(userId, 'unknown'), false, 'an unknown id is still just not found');
});
