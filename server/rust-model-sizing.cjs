'use strict';
// sbstndalton/noevia#2189 (batch M2-A): the Rust front answers the two read-only model sizing reads
// (noevia-rs bins/noevia-server model_sizing.rs): GET /api/models/estimate (the "Will it fit?"
// inputs) and GET /api/models/preset/suggest (the size-based preset suggestion). Both read models.ini,
// the read-only model mounts, the router's /models listing and the saved inference budget; neither
// writes, so neither needs this process's memory. A direct Node GET for either is refused before
// authentication, whoever asks, so a stale route table cannot make two processes answer. Every other
// method of both paths stays here (routes/models.cjs: the administrator check, then 405).
//
// Kept separate from rust-models.cjs (#2187) so the web supervisor and the release assembly can tell
// a Core with this refusal (`require('./rust-model-sizing.cjs')` in index.cjs) from one without it,
// and pair it with a front that lists `rust-model-sizing`.
//
// The list is exactly noevia-rs contracts/http/routes.toml's #2189 owner = "rust" rows, GET only.
const OWNED_PATHS = Object.freeze(['/api/models/estimate', '/api/models/preset/suggest']);
const ROUTE_REFUSAL = Object.freeze({ error: 'Model memory estimates and preset suggestions are owned by the Rust front.', code: 'RUST_MODEL_SIZING_OWNED' });

/** True for the exact pathnames the front owns (core compared `p === '/api/models/...'`, so no trailing slash). */
const owned = (method, pathname) => method === 'GET' && OWNED_PATHS.includes(pathname);

/**
 * Runs before authentication, the maintenance gate and the workspace load (index.cjs
 * handleRequestInner). An unparseable target falls through to the ordinary 400.
 */
function refuseOwned(req, res, { parseRequestUrl, json }) {
  if (req.method !== 'GET') return false;
  const url = parseRequestUrl(req, `http://${req.headers.host || 'localhost'}`) || parseRequestUrl(req);
  if (!url || !owned(req.method, url.pathname)) return false;
  json(res, 503, ROUTE_REFUSAL);
  return true;
}

module.exports = { OWNED_PATHS, ROUTE_REFUSAL, owned, refuseOwned };
