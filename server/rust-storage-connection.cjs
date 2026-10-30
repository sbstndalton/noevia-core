'use strict';
// sbstndalton/noevia#2190 round 4: the Rust front answers PUT /api/integrations/storage (noevia-rs
// bins/noevia-server storage_integration_routes.rs, capability rust-storage-connection) and is the
// only writer of the storage_connections row: the Settings save, a completed Nextcloud sign-in, and
// the legacy WebDAV setup below. Node answered only PUT on this path for the save (GET is the
// metadata worker's, refused by features.cjs refuseRustStorageRead), so only PUT is refused here,
// before authentication: a stale route table cannot make two processes answer.
//
// Node keeps reading the row on every use (auth.cjs getStorage), so a save is in force at once.
// Its database guard (rust-auth.cjs FRONT_TABLES) refuses every INSERT, UPDATE or DELETE of the table
// with RUST_STORAGE_CONNECTION_OWNED, even inside exempt(), except RESEAL_SQL: the same plaintext
// re-encrypted under the current key (getStorage's legacy v1/plaintext upgrade, secrets-rotate.cjs),
// compare-and-swap on the stored value, so it can never undo a save the front made in between.
//
// The legacy WebDAV setup (index.cjs: an administrator's legacy workspace with CORPUS_BACKEND=webdav
// and no configured storage) asks the front through the internal store (project-store-client.cjs
// storageLegacyWebdav, POST /v1/storage/legacy-webdav), which saves only while the account has no
// row or a `local` one, checked inside its write.
const PATH = '/api/integrations/storage';
const ROUTE_REFUSAL = Object.freeze({ error: 'The storage connection is owned by the Rust front.', code: 'RUST_STORAGE_CONNECTION_OWNED' });
const TABLE = 'storage_connections';
// The one Node statement on the table the guard lets run (same plaintext, CAS on the old value).
const RESEAL_SQL = 'UPDATE storage_connections SET secret=? WHERE user_id=? AND secret=?';

function refuseOwned(req, res, { parseRequestUrl, json }) {
  if (req.method !== 'PUT') return false;
  const url = parseRequestUrl(req, `http://${req.headers.host || 'localhost'}`) || parseRequestUrl(req);
  if (!url || url.pathname !== PATH) return false;
  json(res, 503, ROUTE_REFUSAL);
  return true;
}

/** The refusal the database guard throws for any other Node write of the table. */
function writeRefusal() {
  return Object.assign(new Error(ROUTE_REFUSAL.error), { status: 503, code: ROUTE_REFUSAL.code });
}

module.exports = { PATH, ROUTE_REFUSAL, TABLE, RESEAL_SQL, refuseOwned, writeRefusal };
