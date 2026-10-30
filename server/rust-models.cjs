'use strict';
// sbstndalton/noevia#2187 (batch M1): the Rust front answers the two model reads that need nothing
// of this process's memory (noevia-rs bins/noevia-server model_routes.rs): GET /api/models/capabilities
// (the adapter's capabilities, from configuration) and GET /api/models/hardware (the llama.cpp
// adapter cannot discover hardware; no model manager is a 404). A direct Node GET for either is
// refused before authentication, whoever asks, so a stale route table cannot make two processes
// answer. Every other method of both paths stays here (routes/models.cjs: the hardware path's 405).
//
// What stays here with the other 20 model routes, and why (each reads this process's memory or job
// state): /api/model-manager (the folder scan cache), /api/models/autotune* and /calibration* (the
// job runners, batch M2), /api/models/inference-budget (the budget store, its PUT, the shared installed list),
// /api/models/installed (the shared installed list), /api/models/machines (probe and tune caches), the
// writes, and /api/models/{*}. GET /api/models/estimate and GET /api/models/preset/suggest moved in
// batch M2-A (#2189): rust-model-sizing.cjs refuses them.
//
// The list is exactly noevia-rs contracts/http/routes.toml's owner = "rust" model routes, GET only.
const OWNED_PATHS = Object.freeze(['/api/models/capabilities', '/api/models/hardware']);
const ROUTE_REFUSAL = Object.freeze({ error: 'Model capabilities and hardware are owned by the Rust front.', code: 'RUST_MODELS_OWNED' });

/** True for the exact pathnames the front owns (core compared `p === '/api/models/...'`, so no trailing slash). */
const owned = (method, pathname) => method === 'GET' && OWNED_PATHS.includes(pathname);

/**
 * Runs before authentication, the maintenance gate and the workspace load (index.cjs
 * handleRequestInner). `parseRequestUrl` is http.cjs's; an unparseable target falls through to the
 * ordinary 400 the request chain gives it.
 */
function refuseOwned(req, res, { parseRequestUrl, json }) {
  if (req.method !== 'GET') return false;
  const url = parseRequestUrl(req, `http://${req.headers.host || 'localhost'}`) || parseRequestUrl(req);
  if (!url || !owned(req.method, url.pathname)) return false;
  json(res, 503, ROUTE_REFUSAL);
  return true;
}

module.exports = { OWNED_PATHS, ROUTE_REFUSAL, owned, refuseOwned };
