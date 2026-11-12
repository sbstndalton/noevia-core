'use strict';
// Account schema bootstrap; credential verification and touches are native.
function createAppPasswords({ db }) {
  db.exec(`CREATE TABLE IF NOT EXISTS app_passwords(
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL, scope TEXT NOT NULL CHECK(scope IN ('lan','public')),
    password_hash TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER
  ); CREATE INDEX IF NOT EXISTS app_passwords_user ON app_passwords(user_id);`);
  return Object.freeze({});
}
module.exports = { createAppPasswords };
