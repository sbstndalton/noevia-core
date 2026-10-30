'use strict';
// sbstndalton/noevia#2190 round 5: the Rust front answers a stored provider's model list (noevia-rs
// bins/noevia-server provider_models_routes.rs, capability rust-provider-models): GET
// /api/providers/<id>/models[?refresh=1], with the per-account cache, the refresh throttle and the
// shared in-flight fetch. It reads the rows from the files workspace.cjs writes (shared-providers.json,
// users/<id>/providers.json, keys enc:v1) and a Sign in with ChatGPT row's list from its token broker,
// so Node keeps no state the route needs. Node answered every method on the exact path (405 for all
// but GET), so every method is refused here, before authentication. `chatgpt` as the id is the
// broker's static GET /api/providers/chatgpt/models (rust-chatgpt-oauth.cjs); its other methods and
// any longer path stay Node's.
const PATTERN = /^\/api\/providers\/([^/]+)\/models$/;
const ROUTE_REFUSAL = Object.freeze({ error: 'The provider model list is owned by the Rust front.', code: 'RUST_PROVIDER_MODELS_OWNED' });

/** Whether `pathname` is the front's route. */
function owned(pathname) {
  const m = PATTERN.exec(String(pathname || ''));
  return !!m && m[1] !== 'chatgpt';
}

function refuseOwned(req, res, { parseRequestUrl, json }) {
  const url = parseRequestUrl(req, `http://${req.headers.host || 'localhost'}`) || parseRequestUrl(req);
  if (!url || !owned(url.pathname)) return false;
  json(res, 503, ROUTE_REFUSAL);
  return true;
}

module.exports = { ROUTE_REFUSAL, owned, refuseOwned };
