'use strict';
// sbstndalton/noevia#2190: the Rust front answers GET /api/plugins/directory (noevia-rs
// bins/noevia-server plugin_directory_routes.rs): the public MCP registry and Anthropic's skills
// listing, with noevia's starters (plugin-starters.json moved there), its hour-long cache, the two
// fixed hosts, no redirects, an 8 s deadline and a 4 MB cap. Node answered every method of the
// path (405 for all but GET), so every method is refused here, before authentication, whoever
// asks: a stale route table cannot make two processes answer.
//
// routes/plugin-directory.cjs is gone: its last functions went with the project skill install (#2191 round 9)
// and the admin MCP directory (sbstndalton/noevia#2202 round 2).
const OWNED_PATHS = Object.freeze(['/api/plugins/directory']);
const ROUTE_REFUSAL = Object.freeze({ error: 'The plugin directory is owned by the Rust front.', code: 'RUST_PLUGIN_DIRECTORY_OWNED' });

/** The exact pathname, every method (core compared `path !== '/api/plugins/directory'`). */
const owned = (pathname) => OWNED_PATHS.includes(pathname);

function refuseOwned(req, res, { parseRequestUrl, json }) {
  const url = parseRequestUrl(req, `http://${req.headers.host || 'localhost'}`) || parseRequestUrl(req);
  if (!url || !owned(url.pathname)) return false;
  json(res, 503, ROUTE_REFUSAL);
  return true;
}

module.exports = { OWNED_PATHS, ROUTE_REFUSAL, owned, refuseOwned };
