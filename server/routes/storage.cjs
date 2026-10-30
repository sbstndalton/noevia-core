'use strict';

const { RUST_STORAGE_READS_REFUSAL, RUST_STORAGE_BROWSE_REFUSAL } = require('../features.cjs');
const rustStorageIntegrations = require('../rust-storage-integrations.cjs');
const rustStorageConnection = require('../rust-storage-connection.cjs');
// The user's own storage connection (Settings -> Diary & storage) is wholly the Rust front's: reading
// it, browsing and reading files (#1071), creating a folder, testing a connection and the Nextcloud
// Login Flow v2 (rust-storage-integrations.cjs), and saving it (rust-storage-connection.cjs, both
// sbstndalton/noevia#2190). What is left here refuses a request that bypassed the front, before the
// row is read. Auth and CSRF run before routes are mounted.

// The member-origin refusal's text (the front answers it now; ssrf.cjs keeps the policy for Node's
// own outbound calls).
const STORAGE_PRIVATE_URL_ERROR = 'An http(s) server URL is required. This server is not approved for member connections. Ask an administrator to add its origin to MEMBER_OUTBOUND_ORIGINS.';

const PASS = Symbol('unhandled');

/**
 * @param {object} deps
 * @param {(res, status, body) => any} deps.json
 */
function createStorageRoutes({ json }) {
  async function handle(req, res, { path: p }) {
    // sbstndalton/noevia#1071: the connection's metadata GET, the list and the text read belong to
    // the Rust front (noevia-rs crates/server-storage-reads). One that reaches Node is a bypass,
    // refused before the row is read or resealed. (The metadata GET is normally refused even
    // earlier, before authentication: features.cjs refuseRustStorageRead.)
    if (p === '/api/integrations/storage' && req.method === 'GET') return json(res, 503, RUST_STORAGE_READS_REFUSAL);
    if (/^\/api\/integrations\/storage\/files(?:\/.*)?$/.test(p) && req.method === 'GET') return json(res, 503, RUST_STORAGE_BROWSE_REFUSAL);
    if (p === '/api/integrations/storage/file' && req.method === 'POST') return json(res, 503, RUST_STORAGE_BROWSE_REFUSAL);
    // sbstndalton/noevia#2190: the folder write, the connection test and the Nextcloud sign-in belong
    // to the Rust front (noevia-rs storage_integration_routes.rs). One that reaches Node is a bypass,
    // refused before the row is read (they are normally refused even earlier, before
    // authentication: rust-storage-integrations.cjs).
    if (req.method === 'POST' && rustStorageIntegrations.owned(p)) return json(res, 503, rustStorageIntegrations.ROUTE_REFUSAL);

    // sbstndalton/noevia#2190 round 4: saving the connection (PUT) is the Rust front's, which is the
    // only writer of the row (rust-storage-connection.cjs; normally refused before authentication).
    if (p === '/api/integrations/storage' && req.method === 'PUT') return json(res, 503, rustStorageConnection.ROUTE_REFUSAL);
    return PASS;
  }

  return async function storageRoutes(req, res, ctx) {
    return (await handle(req, res, ctx)) !== PASS;
  };
}

module.exports = { createStorageRoutes, STORAGE_PRIVATE_URL_ERROR };
