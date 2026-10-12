'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createAppPasswords } = require('./app-passwords.cjs');
function fixture(t, rateLimited = () => false) {
  const db = new Database(':memory:'); db.pragma('foreign_keys=ON');
  db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,username_norm TEXT,disabled_at INTEGER,credential_epoch INTEGER NOT NULL DEFAULT 0);
    INSERT INTO users(id,username_norm,disabled_at) VALUES('alice','alice',NULL),('bob','bob',NULL);`);
  const events = [];
  const passwords = createAppPasswords({ db, audit: (...args) => events.push(args), rateLimited });
  t.after(() => db.close()); return { db, passwords, events };
}
test('app passwords are hashed, shown once, tenant/scoped, individually revocable and audited without secrets', async t => {
  const { db, passwords:p, events } = fixture(t);
  const a = await p.create('alice', { name: ' Laptop ', scope: 'lan' });
  const b = await p.create('alice', { name: 'Phone', scope: 'public' });
  assert.match(a.password, /^nv_dav_[a-f0-9]{32}\.[A-Za-z0-9_-]{43}$/);
  assert.match(db.prepare('SELECT password_hash FROM app_passwords WHERE id=?').get(a.id).password_hash, /^\$argon2id\$/);
  assert.equal(p.list('alice')[0].name, 'Laptop'); assert.deepEqual(p.list('bob'), []);
  assert.ok(!JSON.stringify(p.list('alice')).includes(a.password));
  assert.equal(await p.verifyDav('alice', a.password, 'public'), null);
  assert.equal(await p.verifyDav('bob', a.password, 'lan'), null);
  assert.equal(await p.verifyDav('alice', a.password.slice(0,-1)+'!', 'lan'), null);
  assert.equal(p.list('alice')[0].lastUsedAt, null);
  assert.equal((await p.verifyDav('ALICE', a.password, 'lan')).userId, 'alice');
  assert.ok(p.list('alice')[0].lastUsedAt);
  assert.equal(p.revoke('bob', a.id), false); assert.equal(p.revoke('alice', a.id), true);
  assert.equal(await p.verifyDav('alice', a.password, 'lan'), null);
  assert.ok(await p.verifyDav('alice', b.password, 'public'));
  assert.deepEqual(events.map(e => e[0]), ['app-password.create','app-password.create','app-password.revoke']);
  assert.ok(!JSON.stringify(events).includes(a.password));
  db.prepare("UPDATE users SET disabled_at=1 WHERE id='alice'").run();
  assert.equal(await p.verifyDav('alice', b.password, 'public'), null);
  await assert.rejects(p.create('alice', { name:'disabled', scope:'lan' }), /unavailable/);
  db.prepare("DELETE FROM users WHERE id='alice'").run(); assert.deepEqual(p.list('alice'), []);
});
test('app password validation, creation throttling and transactional cap are bounded', async t => {
  const { passwords:p, db } = fixture(t);
  for (const value of [{name:'',scope:'lan'},{name:'x',scope:'off'},{name:'x\n',scope:'lan'},{name:'x'.repeat(81),scope:'lan'}]) await assert.rejects(p.create('alice',value));
  const { passwords:limited } = fixture(t, () => true);
  await assert.rejects(limited.create('alice',{name:'Laptop',scope:'lan'}), /Wait/);
  const insert = db.prepare('INSERT INTO app_passwords VALUES(?,?,?,?,?,?,?)');
  for (let i=0;i<19;i++) insert.run(String(i),'alice','fixture','lan','unused',i,null);
  const results=await Promise.allSettled([p.create('alice',{name:'one',scope:'lan'}),p.create('alice',{name:'two',scope:'public'})]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1); assert.equal(p.list('alice').length,20);
});
test('revocation and account disable during asynchronous verification prevent authorization', async t => {
  const { passwords:p, db } = fixture(t);
  let a = await p.create('alice',{name:'Laptop',scope:'lan'});
  let pending = p.verifyDav('alice',a.password,'lan'); p.revoke('alice',a.id);
  assert.equal(await pending,null);
  a=await p.create('alice',{name:'Other',scope:'lan'});
  pending=p.verifyDav('alice',a.password,'lan'); db.prepare("UPDATE users SET disabled_at=1 WHERE id='alice'").run();
  assert.equal(await pending,null);
});
test('every DAV rejection past the format check costs one Argon2 verify, so timing does not reveal accounts (noevia#1253)', async t => {
  const { verify: realVerify } = require('@node-rs/argon2');
  const db = new Database(':memory:'); db.pragma('foreign_keys=ON');
  db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,username_norm TEXT,disabled_at INTEGER,credential_epoch INTEGER NOT NULL DEFAULT 0);
    INSERT INTO users(id,username_norm,disabled_at) VALUES('alice','alice',NULL),('carol','carol',1);`);
  t.after(() => db.close());
  const seen = [];
  const passwords = createAppPasswords({ db, audit: () => {}, rateLimited: () => false,
    verifyHash: (stored, password) => { seen.push(stored); return realVerify(stored, password); } });
  const a = await passwords.create('alice', { name: 'Laptop', scope: 'lan' });
  const d = await passwords.create('alice', { name: 'Public', scope: 'public' });
  // Attack inputs: a well-formed `nv_dav_<32 hex>.<43 base64url>` password (the attacker's own, or a
  // random one with an id that exists for no account), sent with a username that is real, unknown,
  // disabled, or real with the other scope.
  const unknownId = `nv_dav_${'0'.repeat(32)}.${'A'.repeat(43)}`;
  const cases = [
    ['alice', a.password, 'lan', true],            // right user, right credential, right scope
    ['alice', a.password.slice(0, -1) + 'A', 'lan', false], // right id, wrong secret
    ['ghost', a.password, 'lan', false],           // unknown username
    ['alice', unknownId, 'lan', false],            // real username, credential that does not exist
    ['carol', a.password, 'lan', false],           // disabled account (its own credential does not exist here)
    ['alice', d.password, 'lan', false],           // credential of the other scope
  ];
  for (const [username, password, scope, ok] of cases) {
    seen.length = 0;
    const result = await passwords.verifyDav(username, password, scope);
    assert.equal(seen.length, 1, `${username} ${scope}: exactly one Argon2 verify`);
    assert.match(seen[0], /^\$argon2id\$/);
    assert.equal(result !== null, ok, `${username} ${scope}`);
  }
  // The decoy is a real hash of the same parameters, not a stored credential.
  const stored = db.prepare('SELECT password_hash FROM app_passwords WHERE id=?').all(a.id).map(r => r.password_hash);
  seen.length = 0; await passwords.verifyDav('ghost', a.password, 'lan');
  assert.ok(!stored.includes(seen[0]));
  // A malformed secret never reaches the database or Argon2 (no account is named by that shape).
  seen.length = 0;
  assert.equal(await passwords.verifyDav('alice', 'not-a-dav-password', 'lan'), null);
  assert.equal(seen.length, 0);
});
