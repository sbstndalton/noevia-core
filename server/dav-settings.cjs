'use strict';
// Schema bootstrap remains here with the account migrator; no listener or opt-in reader.
function createDavSettings({ auth }) {
  auth.db.exec(`CREATE TABLE IF NOT EXISTS dav_settings(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    scope TEXT NOT NULL CHECK(scope IN ('off','lan','public')), acknowledged_at INTEGER, updated_at INTEGER NOT NULL);`);
}
module.exports = { createDavSettings };
