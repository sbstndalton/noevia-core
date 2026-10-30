'use strict';
// sbstndalton/noevia#2202 round 2: Settings -> Connectors' list and the Nextcloud permissions are the Rust
// front's (noevia-rs bins/noevia-server nextcloud_routes.rs, capability rust-connectors):
//   GET /api/connectors, PUT /api/connectors/nextcloud/policy
// (the Google Drive writes were its since #2190 round 7, rust-google-drive.cjs). The Nextcloud half joins
// the account's storage connection and its tool permissions, both the front's, with the tools the
// Nextcloud MCP server offers and which of them write - the one thing only this process's live client
// knows, which it publishes in the discovery snapshot (mcp-discovery-snapshot.cjs). The origin allow-list
// (MCP_NEXTCLOUD_ORIGINS) is published with it, so the front forwards nothing this process would not.
//
// Node refuses exactly those methods on those paths before authentication.
const ROUTES = Object.freeze([
  ['GET', /^\/api\/connectors$/],
  ['PUT', /^\/api\/connectors\/nextcloud\/policy$/],
]);
const ROUTE_REFUSAL = Object.freeze({ error: 'The connectors list and the Nextcloud permissions are owned by the Rust front.', code: 'RUST_CONNECTORS_OWNED' });

function owned(method, pathname) {
  return ROUTES.some(([m, re]) => m === method && re.test(pathname));
}

function refuseOwned(req, res, { parseRequestUrl, json }) {
  const url = parseRequestUrl(req, `http://${req.headers.host || 'localhost'}`) || parseRequestUrl(req);
  if (!url || !owned(req.method, url.pathname)) return false;
  json(res, 503, ROUTE_REFUSAL);
  return true;
}

module.exports = { ROUTES, ROUTE_REFUSAL, owned, refuseOwned };
