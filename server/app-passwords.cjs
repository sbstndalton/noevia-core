'use strict';
const crypto = require('node:crypto');
const { hash, verify, Algorithm } = require('@node-rs/argon2');

// DAV credentials have no connection to session issuance or account passwords.
function createAppPasswords({ db, audit, rateLimited }) {
  db.exec(`CREATE TABLE IF NOT EXISTS app_passwords(
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL, scope TEXT NOT NULL CHECK(scope IN ('lan','public')),
    password_hash TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER
  ); CREATE INDEX IF NOT EXISTS app_passwords_user ON app_passwords(user_id);`);
  const active = id => !!db.prepare('SELECT id FROM users WHERE id=? AND disabled_at IS NULL').get(id);
  const list = userId => db.prepare(`SELECT id,name,scope,created_at AS createdAt,last_used_at AS lastUsedAt
    FROM app_passwords WHERE user_id=? ORDER BY created_at,id`).all(userId);
  return {
    list,
    async create(userId, { name, scope } = {}) {
      if (typeof name !== 'string' || !name.trim() || name.trim().length > 80 || /[\x00-\x1f\x7f]/.test(name)) throw Error('Use a device name of 1–80 characters.');
      if (!['lan', 'public'].includes(scope)) throw Error('Choose a LAN or public credential scope.');
      if (!active(userId)) throw Error('Account unavailable.');
      if (rateLimited(`app-password:create:${userId}`, 5, 60000)) throw Error('Wait a minute before generating another app password.');
      if (list(userId).length >= 20) throw Error('Revoke an app password before creating another (limit 20).');
      const id = crypto.randomBytes(16).toString('hex');
      const password = `nv_dav_${id}.${crypto.randomBytes(32).toString('base64url')}`;
      const passwordHash = await hash(password, { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
      const createdAt = Date.now();
      db.transaction(() => {
        // Recheck after asynchronous hashing: disable/delete and concurrent minting win.
        if (!active(userId)) throw Error('Account unavailable.');
        if (list(userId).length >= 20) throw Error('Revoke an app password before creating another (limit 20).');
        db.prepare('INSERT INTO app_passwords(id,user_id,name,scope,password_hash,created_at) VALUES(?,?,?,?,?,?)')
          .run(id, userId, name.trim(), scope, passwordHash, createdAt);
        audit('app-password.create', userId, userId, { id, scope });
      })();
      return { id, name: name.trim(), scope, createdAt, lastUsedAt: null, password };
    },
    revoke(userId, id) {
      return db.transaction(() => {
        const removed = db.prepare('DELETE FROM app_passwords WHERE id=? AND user_id=?').run(id, userId).changes > 0;
        if (removed) audit('app-password.revoke', userId, userId, { id });
        return removed;
      })();
    },
    // Only a future dedicated DAV listener may call this after transport/scope
    // validation and request rate limiting. Never use as app authentication.
    async verifyDav(username, password, scope) {
      if (!['lan', 'public'].includes(scope) || typeof password !== 'string') return null;
      const match = /^nv_dav_([a-f0-9]{32})\.[A-Za-z0-9_-]{43}$/.exec(password);
      if (!match || typeof username !== 'string' || username.length > 32) return null;
      const row = db.prepare(`SELECT a.*,u.username_norm FROM app_passwords a JOIN users u ON u.id=a.user_id
        WHERE a.id=? AND u.username_norm=? AND u.disabled_at IS NULL AND a.scope=?`).get(match[1], username.toLowerCase(), scope);
      if (!row || !await verify(row.password_hash, password).catch(() => false)) return null;
      // Revocation or account disable while Argon2 runs must take effect now.
      const updated = db.prepare(`UPDATE app_passwords SET last_used_at=? WHERE id=? AND password_hash=?
        AND EXISTS (SELECT 1 FROM users WHERE id=app_passwords.user_id AND disabled_at IS NULL)`)
        .run(Date.now(), row.id, row.password_hash).changes;
      return updated ? { userId: row.user_id, credentialId: row.id, scope: row.scope } : null;
    },
  };
}
module.exports = { createAppPasswords };
