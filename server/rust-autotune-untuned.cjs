'use strict';
const OWNED_ROUTES = Object.freeze(new Set(['ALL /api/models/autotune/untuned']));
const ROUTE_REFUSAL = Object.freeze({ error: 'Untuned model discovery is owned by the Rust front.', code: 'RUST_AUTOTUNE_UNTUNED_OWNED' });
function refuseOwned(req, res, { parseRequestUrl, json }) {
  const url = parseRequestUrl(req);
  if (!url || url.pathname !== '/api/models/autotune/untuned') return false;
  json(res, 503, ROUTE_REFUSAL); return true;
}
module.exports = { OWNED_ROUTES, ROUTE_REFUSAL, refuseOwned };
