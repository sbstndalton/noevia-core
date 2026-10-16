'use strict';
const crypto = require('node:crypto');
const { hash, verify, Algorithm } = require('@node-rs/argon2');

// DAV credentials have no connection to session issuance or account passwords. Creating, listing
// and revoking them in Settings is the Rust front's (sbstndalton/noevia#1071); this module keeps
// the DAV listener's read of them (list, verifyDav) and its last_used_at write.
const ARGON2_OPTIONS = { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };
function createAppPasswords({ db, guard, verifyHash = (stored, password) => verify(stored, password), makeDecoy = () => hash(crypto.randomBytes(32).toString('base64url'), ARGON2_OPTIONS) }) {
  // #1253: a DAV login that names no usable credential still runs one Argon2 verify (against a decoy
  // hash with the same parameters), so the response time does not say whether the username exists,
  // is disabled, or has that credential. Built at start-up (so the first miss is not the slow one) and
  // rebuilt on demand: a failed build is never cached, so one transient failure cannot turn every later
  // miss into a fast empty-hash check (#1577).
  let decoyHash = null;
  const decoy = () => {
    const pending = decoyHash ||= Promise.resolve().then(makeDecoy);
    pending.catch(() => { if (decoyHash === pending) decoyHash = null; });
    return pending;
  };
  decoy().catch(() => {});
  // The DAV listener stays Node's while the Rust front owns app passwords (rust-auth.cjs): its
  // last_used_at write is the one exemption here.
  const { exempt } = guard;
  db.exec(`CREATE TABLE IF NOT EXISTS app_passwords(
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL, scope TEXT NOT NULL CHECK(scope IN ('lan','public')),
    password_hash TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER
  ); CREATE INDEX IF NOT EXISTS app_passwords_user ON app_passwords(user_id);`);
  const list = userId => db.prepare(`SELECT id,name,scope,created_at AS createdAt,last_used_at AS lastUsedAt
    FROM app_passwords WHERE user_id=? ORDER BY created_at,id`).all(userId);
  return {
    list,
    // Only a future dedicated DAV listener may call this after transport/scope
    // validation and request rate limiting. Never use as app authentication.
    async verifyDav(username, password, scope) {
      if (!['lan', 'public'].includes(scope) || typeof password !== 'string') return null;
      const match = /^nv_dav_([a-f0-9]{32})\.[A-Za-z0-9_-]{43}$/.exec(password);
      if (!match || typeof username !== 'string' || username.length > 32) return null;
      const row = db.prepare(`SELECT a.*,u.username_norm FROM app_passwords a JOIN users u ON u.id=a.user_id
        WHERE a.id=? AND u.username_norm=? AND u.disabled_at IS NULL AND a.scope=?`).get(match[1], username.toLowerCase(), scope);
      // Same work on every path past the format check: a real stored hash when the lookup found one
      // (wrong or right password), the decoy when it did not (unknown user, disabled account, other
      // scope, other credential). Only the answer below differs.
      // A decoy that cannot be built fails closed: the miss is refused without a fast empty-hash check.
      const stored = row ? row.password_hash : await decoy().catch(() => decoy()).catch(() => null);
      if (stored === null) return null;
      const matched = await verifyHash(stored, password).catch(() => false);
      if (!row || matched !== true) return null;
      // Revocation or account disable while Argon2 runs must take effect now.
      const updated = exempt(() => db.prepare(`UPDATE app_passwords SET last_used_at=? WHERE id=? AND password_hash=?
        AND EXISTS (SELECT 1 FROM users WHERE id=app_passwords.user_id AND disabled_at IS NULL)`)
        .run(Date.now(), row.id, row.password_hash).changes);
      return updated ? { userId: row.user_id, credentialId: row.id, scope: row.scope } : null;
    },
  };
}
module.exports = { createAppPasswords };
