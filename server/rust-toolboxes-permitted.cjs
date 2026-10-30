'use strict';
// sbstndalton/noevia#2202 round 2: GET /api/toolboxes/permitted is the Rust front's (noevia-rs
// bins/noevia-server toolbox_routes.rs, capability rust-toolboxes-permitted). The front computes the view
// from what it owns at the time of the request (the project's toolbox selection, the account's tool
// permissions, its Drive connection, its MCP sign-ins and keys, the Diary add-on preference, the
// directory) and from the discovery snapshot this process publishes (mcp-discovery-snapshot.cjs): the
// offered boxes with their tools, whether each tool writes, the configured boxes, the coding harness
// switch and whether a repository is registered. There is no cache here any more (the 30 s one went
// stale after every write the front made), and none in the front.
//
// Node refuses every method of the exact path before authentication.
const ROUTES = Object.freeze([/^\/api\/toolboxes\/permitted$/]);
const ROUTE_REFUSAL = Object.freeze({ error: 'The permitted tools view is owned by the Rust front.', code: 'RUST_TOOLBOXES_PERMITTED_OWNED' });

function owned(pathname) {
  return ROUTES.some((re) => re.test(pathname));
}

function refuseOwned(req, res, { parseRequestUrl, json }) {
  const url = parseRequestUrl(req, `http://${req.headers.host || 'localhost'}`) || parseRequestUrl(req);
  if (!url || !owned(url.pathname)) return false;
  json(res, 503, ROUTE_REFUSAL);
  return true;
}

module.exports = { ROUTES, ROUTE_REFUSAL, owned, refuseOwned };
