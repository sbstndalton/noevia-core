'use strict';
// Test support for sbstndalton/noevia#2190 round 4: the Rust front is the only writer of the
// storage_connections row (noevia-rs storage_integration_routes.rs `write_row`), and Node's
// database guard refuses its own writes of it. Tests that need a saved connection write it as the
// front does: on a separate, unguarded connection, with core's former `saveStorage` normalization
// (the kind list, trailing slashes, the region rule) and the secret sealed enc:v2 to the account.
// Synthetic data only.
const path = require('node:path');

/** Runs `fn(db)` on a separate connection to `<root>/cowork.db` (the front's). */
function asFront(root, fn) {
  const Database = require(require.resolve('better-sqlite3', { paths: [path.join(__dirname, '..', '..', 'server')] }));
  const db = new Database(path.join(root, 'cowork.db'));
  db.pragma('busy_timeout = 5000');
  try { return fn(db); } finally { db.close(); }
}

/** Saves `value` for `userId` exactly as the front's PUT does; `secrets` seals (null: stored as is). */
function saveStorageAsFront(root, secrets, userId, value) {
  const { normalizeS3Region } = require('../../server/s3-region.cjs');
  const kind = ['local', 'nextcloud', 'webdav', 's3'].includes(value.kind) ? value.kind : 'local';
  const sealed = secrets ? secrets.encrypt(value.secret || '', userId) : (value.secret || '');
  asFront(root, (db) => {
    db.prepare(`INSERT INTO storage_connections(user_id,kind,base_url,bucket,region,username,secret,corpus_root,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET kind=excluded.kind,base_url=excluded.base_url,
      bucket=excluded.bucket,region=excluded.region,username=excluded.username,secret=excluded.secret,corpus_root=excluded.corpus_root,updated_at=excluded.updated_at`)
      .run(userId, kind, String(value.baseUrl || '').replace(/\/+$/, ''), String(value.bucket || '').replace(/\/+$/, ''),
        normalizeS3Region(value.region), String(value.username || ''), sealed, String(value.corpusRoot || ''), Date.now());
    db.prepare('INSERT INTO audit_events(actor_user_id,target_user_id,action,detail,created_at) VALUES(?,?,?,?,?)')
      .run(userId, userId, 'storage.update', JSON.stringify({ kind }), Date.now());
  });
}

/** Runs one statement on the front's connection (a forged or legacy row). */
function frontRun(root, sql, ...args) {
  return asFront(root, (db) => db.prepare(sql).run(...args));
}

module.exports = { asFront, saveStorageAsFront, frontRun };
