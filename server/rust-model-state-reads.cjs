'use strict';
// sbstndalton/noevia#2262 (group rust-model-state-reads): GET /api/models/inference-budget and GET /api/models/installed are
// the Rust front's (noevia-rs bins/noevia-server model_state_routes.rs). Node keeps the budget's PUT (its cache of the saved
// figure and the audit) and every internal reader of the installed list; what the front cannot know comes over the loopback
// bridge (rust-model-facts.cjs). A direct Node GET is refused before authentication, whoever asks, so a stale route table
// cannot make two processes answer. Kept separate from rust-models.cjs so the supervisor and the release assembly can tell a
// Core with this refusal from one without it.
//
// The list is exactly noevia-rs contracts/http/routes.toml's rows for this group, GET only.
const OWNED_PATHS = Object.freeze(['/api/models/inference-budget', '/api/models/installed']);
const ROUTE_REFUSAL = Object.freeze({ error: 'The inference budget and installed model reads are owned by the Rust front.', code: 'RUST_MODEL_STATE_READS_OWNED' });

/** True for the exact pathnames the front owns (core compared `p === '/api/models/...'`, so no trailing slash). */
const owned = (method, pathname) => method === 'GET' && OWNED_PATHS.includes(pathname);

/** Runs before authentication, the maintenance gate and the workspace load (index.cjs). An unparseable target falls through. */
function refuseOwned(req, res, { parseRequestUrl, json }) {
  if (req.method !== 'GET') return false;
  const url = parseRequestUrl(req, `http://${req.headers.host || 'localhost'}`) || parseRequestUrl(req);
  if (!url || !owned(req.method, url.pathname)) return false;
  json(res, 503, ROUTE_REFUSAL);
  return true;
}

module.exports = { OWNED_PATHS, ROUTE_REFUSAL, owned, refuseOwned };
