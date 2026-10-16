'use strict';
// The DAV listener's side of app passwords: verifyDav, the list it checks, and its last_used_at
// write (the one rust-auth.cjs exemption here). Creating and revoking app passwords is the Rust
// front's (sbstndalton/noevia#1071; noevia-rs crates/server-account): the credentials are minted
// here through a separate, unguarded connection, the way the front writes them.
const test = require('node:test'), assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Database = require('better-sqlite3');
const { hash, Algorithm } = require('@node-rs/argon2');
const { createAppPasswords } = require('./app-passwords.cjs');
const { createRustAuthGuard } = require('./rust-auth.cjs');

const ARGON2 = { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };

function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-app-passwords-'));
  const file = path.join(dir, 'cowork.db');
  // The front's connection: the schema and the accounts.
  const front = new Database(file); front.pragma('foreign_keys=ON');
  front.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,username_norm TEXT,disabled_at INTEGER,credential_epoch INTEGER NOT NULL DEFAULT 0);
    INSERT INTO users(id,username_norm,disabled_at) VALUES('alice','alice',NULL),('bob','bob',NULL),('carol','carol',1);`);
  // Node's connection, with the guard installed as auth.cjs does.
  const guard = createRustAuthGuard();
  const db = new Database(file); db.pragma('foreign_keys=ON');
  const passwords = createAppPasswords({ db, guard, ...options });
  guard.install(db);
  t.after(() => { db.close(); front.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  /** An app password the front minted for `userId` (the shape POST /api/profile/app-passwords returns). */
  async function mint(userId, { name = 'Device', scope = 'lan', bytes = (n) => crypto.randomBytes(n) } = {}) {
    const id = bytes(16).toString('hex');
    const password = `nv_dav_${id}.${bytes(32).toString('base64url')}`;
    front.prepare('INSERT INTO app_passwords(id,user_id,name,scope,password_hash,created_at) VALUES(?,?,?,?,?,?)')
      .run(id, userId, name, scope, await hash(password, ARGON2), Date.now());
    return { id, password };
  }
  return { db, front, passwords, mint };
}
// #1642: a wrong secret must differ from the real one whatever its last character is. The last
// base64url character of a 32-byte secret carries only four random bits, so 'A' is one of 16
// values and a fixed 'A' suffix was the real password about 1 run in 16.
const otherLastCharacter = (password) => password.slice(0, -1) + (password.endsWith('A') ? 'B' : 'A');

test('app passwords are tenant/scoped for DAV, and a use is recorded through the exemption only', async t => {
  const { db, front, passwords: p, mint } = fixture(t);
  const a = await mint('alice', { name: 'Laptop', scope: 'lan' });
  const b = await mint('alice', { name: 'Phone', scope: 'public' });
  assert.equal(p.list('alice')[0].name, 'Laptop'); assert.deepEqual(p.list('bob'), []);
  assert.ok(!JSON.stringify(p.list('alice')).includes(a.password));
  assert.equal(await p.verifyDav('alice', a.password, 'public'), null);
  assert.equal(await p.verifyDav('bob', a.password, 'lan'), null);
  assert.equal(await p.verifyDav('alice', a.password.slice(0, -1) + '!', 'lan'), null);
  assert.equal(p.list('alice')[0].lastUsedAt, null);
  assert.equal((await p.verifyDav('ALICE', a.password, 'lan')).userId, 'alice');
  assert.ok(p.list('alice')[0].lastUsedAt, 'the DAV listener records the use (rust-auth.cjs exemption)');
  // Outside the exemption Node's connection writes none of it.
  assert.throws(() => db.prepare('UPDATE app_passwords SET last_used_at=1').run(), (e) => e.code === 'RUST_AUTH_OWNED');
  assert.throws(() => db.prepare('DELETE FROM app_passwords').run(), (e) => e.code === 'RUST_AUTH_OWNED');
  // Revoked by the front: refused at once.
  front.prepare('DELETE FROM app_passwords WHERE id=?').run(a.id);
  assert.equal(await p.verifyDav('alice', a.password, 'lan'), null);
  assert.ok(await p.verifyDav('alice', b.password, 'public'));
  front.prepare("UPDATE users SET disabled_at=1 WHERE id='alice'").run();
  assert.equal(await p.verifyDav('alice', b.password, 'public'), null);
  assert.equal(typeof p.create, 'undefined', 'creating one is the Rust front\'s');
  assert.equal(typeof p.revoke, 'undefined', 'revoking one is the Rust front\'s');
});

test('revocation and account disable during asynchronous verification prevent authorization', async t => {
  const { front, passwords: p, mint } = fixture(t);
  let a = await mint('alice', { name: 'Laptop' });
  let pending = p.verifyDav('alice', a.password, 'lan'); front.prepare('DELETE FROM app_passwords WHERE id=?').run(a.id);
  assert.equal(await pending, null);
  a = await mint('alice', { name: 'Other' });
  pending = p.verifyDav('alice', a.password, 'lan'); front.prepare("UPDATE users SET disabled_at=1 WHERE id='alice'").run();
  assert.equal(await pending, null);
});

test('every DAV rejection past the format check costs one Argon2 verify, so timing does not reveal accounts (noevia#1253)', async t => {
  const { verify: realVerify } = require('@node-rs/argon2');
  const seen = [];
  const { front, passwords, mint } = fixture(t, { verifyHash: (stored, password) => { seen.push(stored); return realVerify(stored, password); } });
  const a = await mint('alice', { name: 'Laptop', scope: 'lan' });
  const d = await mint('alice', { name: 'Public', scope: 'public' });
  // Attack inputs: a well-formed `nv_dav_<32 hex>.<43 base64url>` password (the attacker's own, or a
  // random one with an id that exists for no account), sent with a username that is real, unknown,
  // disabled, or real with the other scope.
  const unknownId = `nv_dav_${'0'.repeat(32)}.${'A'.repeat(43)}`;
  const cases = [
    ['alice', a.password, 'lan', true],            // right user, right credential, right scope
    ['alice', otherLastCharacter(a.password), 'lan', false], // right id, wrong secret
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
  const stored = front.prepare('SELECT password_hash FROM app_passwords WHERE id=?').all(a.id).map(r => r.password_hash);
  seen.length = 0; await passwords.verifyDav('ghost', a.password, 'lan');
  assert.ok(!stored.includes(seen[0]));
  // A malformed secret never reaches the database or Argon2 (no account is named by that shape).
  seen.length = 0;
  assert.equal(await passwords.verifyDav('alice', 'not-a-dav-password', 'lan'), null);
  assert.equal(seen.length, 0);
});

test('a failed decoy build is never cached: later misses still verify against a real hash (noevia#1577)', async t => {
  const { hash: realHash, verify: realVerify } = require('@node-rs/argon2');
  let builds = 0; const seen = [];
  const { passwords } = fixture(t, {
    makeDecoy: () => { builds++; if (builds <= 2) return Promise.reject(Error('argon2 hiccup')); return realHash('decoy-secret', ARGON2); },
    verifyHash: (stored, password) => { seen.push(stored); return realVerify(stored, password); },
  });
  const miss = `nv_dav_${'0'.repeat(32)}.${'A'.repeat(43)}`;
  // Start-up build and the first miss's own retry both fail: refused, and never the empty-hash fast path.
  assert.equal(await passwords.verifyDav('ghost', miss, 'lan'), null);
  assert.deepEqual(seen, []);
  // The failure was not cached: the next misses build a real decoy and pay a real verify each time.
  for (let i = 0; i < 3; i++) { assert.equal(await passwords.verifyDav('ghost', miss, 'lan'), null); }
  assert.equal(seen.length, 3);
  for (const stored of seen) assert.match(stored, /^\$argon2id\$/);
  assert.ok(!seen.includes(''));
});

test('a wrong secret that differs only in its last character is refused when the real secret ends in A (noevia#1642)', async t => {
  // Zero random bytes make the id 32 zeros and the secret 43 'A' characters (base64url of 32 zero bytes).
  const { passwords: p, mint } = fixture(t);
  const a = await mint('alice', { name: 'Laptop', scope: 'lan', bytes: (n) => Buffer.alloc(n) });
  assert.equal(a.password, `nv_dav_${'0'.repeat(32)}.${'A'.repeat(43)}`);
  // The old test built its wrong secret as slice(0, -1) + 'A', which here is the real password and verified.
  assert.equal(await p.verifyDav('alice', otherLastCharacter(a.password), 'lan'), null);
  assert.equal(await p.verifyDav('alice', a.password.slice(0, -1) + 'B', 'lan'), null);
  assert.ok(await p.verifyDav('alice', a.password, 'lan'));
});
