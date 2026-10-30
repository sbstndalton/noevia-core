'use strict';
// The Diary connector credentials are the Rust front's (sbstndalton/noevia#2206, rust-diary-routes.cjs;
// noevia-rs crates/server-diary `connector`): it makes, lists, revokes and verifies them, and is the
// only writer of the table (rust-auth.cjs FRONT_TABLES refuses every statement of this process).
// What this process still does is create the table at boot, in the shape the front writes and a
// rollback reads: only the credential's SHA-256 is kept, never the credential, so there is no secret to
// seal or to reseal on a key rotation.
function ensureTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS diary_connectors(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,name TEXT NOT NULL,token_hash TEXT NOT NULL,created_at INTEGER NOT NULL)`);
}
module.exports = { ensureTable };
