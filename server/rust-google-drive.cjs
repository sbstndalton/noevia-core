'use strict';
// sbstndalton/noevia#2190 round 7: the Rust front is Google Drive's token authority (noevia-rs
// bins/noevia-server gdrive.rs and connector_routes.rs, capability rust-google-drive). It owns every
// Google OAuth state: each account's device sign-in and sealed refresh token (google-drive-users/<id>.sealed),
// the off-site backup's slot (google-drive.sealed, the administrator's personal connection too) and the
// refresh. It answers the Google Drive writes of Settings -> Connectors and is the only writer of
// tool_policies. Node answered exactly these methods on these paths, so only they are refused here,
// before authentication: a stale route table cannot make two processes answer.
//
// GET /api/connectors and PUT /api/connectors/nextcloud/policy followed in sbstndalton/noevia#2202 round 2
// (rust-connectors.cjs): the Nextcloud half lists the toolbox tools the live MCP servers offer and whether each
// writes, which this process publishes for the front (mcp-discovery-snapshot.cjs). The store calls it used to make
// for that page are gone from the client and from the front.
//
// Node's chat tools hold no refresh token: they ask the broker for a short-lived access token over the
// internal store (gdrive-broker.cjs) and re-ask when the broker's state file moves. This file names
// that file (SIGNAL_FILE): no secret and no email in it, only which accounts have a connection and in
// what state, and the backup slot's, so the sync `connected(user)` needs no round trip.
const ROUTES = Object.freeze({
  '/api/connectors/gdrive/connect': 'POST',
  '/api/connectors/gdrive/disconnect': 'POST',
  '/api/connectors/gdrive/policy': 'PUT',
  '/api/connectors/gdrive/backup-copy': 'PUT',
});
const ROUTE_REFUSAL = Object.freeze({ error: 'Google Drive is owned by the Rust front.', code: 'RUST_GOOGLE_DRIVE_OWNED' });
const TABLE = 'tool_policies';
const SIGNAL_FILE = 'gdrive-connections.json';

/** Whether `method` on the exact `pathname` is the front's. */
function owned(method, pathname) {
  return Object.hasOwn(ROUTES, pathname) && ROUTES[pathname] === method;
}

function refuseOwned(req, res, { parseRequestUrl, json }) {
  const url = parseRequestUrl(req, `http://${req.headers.host || 'localhost'}`) || parseRequestUrl(req);
  if (!url || !owned(req.method, url.pathname)) return false;
  json(res, 503, ROUTE_REFUSAL);
  return true;
}

module.exports = { ROUTES, ROUTE_REFUSAL, TABLE, SIGNAL_FILE, owned, refuseOwned };
