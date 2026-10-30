'use strict';
// sbstndalton/noevia#2202 round 2: the Rust front owns the admin MCP directory (noevia-rs
// bins/noevia-server mcp_directory.rs, mcp_directory_routes.rs, capability rust-mcp-directory):
//   GET|POST /api/admin/mcp-directory, POST /api/admin/mcp-directory/custom and /custom/preview,
//   PUT /api/admin/mcp-directory/{id}/keys and /{id}/oauth-client, DELETE /api/admin/mcp-directory/{id}
// (every method of those paths: an administrator gets 403 or 405 from the front as this process did).
// The front lists a candidate server's tools itself, is the only writer of directory_mcp_servers (the
// server rows and the administrators' shared key slot; rust-auth.cjs FRONT_TABLES refuses every Node
// write of it) and re-seals that slot for a secrets rotation through its broker (resealMcpCredentials).
//
// What stays here is the chat-time MCP client: it re-reads the table (directory-mcp.cjs, with
// shared-reread.cjs createReread on a change signal; an unreadable table means no directory servers)
// and opens each server's shared key only when a call or a discovery needs it. Node publishes what only
// its live client knows - the tools each server offers - for the front's admin listing, the permitted
// tools and the connectors page (mcp-discovery-snapshot.cjs).
//
// Node refuses exactly the paths the front's route table gives Rust (a segment matches `[^/]+`, one
// trailing slash is tolerated) before authentication, so a stale route table cannot make two processes
// answer.
const ROUTES = Object.freeze([
  /^\/api\/admin\/mcp-directory\/?$/,
  /^\/api\/admin\/mcp-directory\/custom\/?$/,
  /^\/api\/admin\/mcp-directory\/custom\/preview\/?$/,
  /^\/api\/admin\/mcp-directory\/[^/]+\/?$/,
  /^\/api\/admin\/mcp-directory\/[^/]+\/keys\/?$/,
  /^\/api\/admin\/mcp-directory\/[^/]+\/oauth-client\/?$/,
]);
const ROUTE_REFUSAL = Object.freeze({ error: 'The MCP directory is owned by the Rust front.', code: 'RUST_MCP_DIRECTORY_OWNED' });

/** Whether this pathname is one of the front's (any method). */
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
