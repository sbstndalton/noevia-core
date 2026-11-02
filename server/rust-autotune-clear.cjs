'use strict';
// #2293: every method on this path is Rust's, including availability-before-method ordering.
const OWNED_ROUTES = Object.freeze(new Set(['ALL /api/models/autotune/clear']));
const ROUTE_REFUSAL = Object.freeze({ error: 'Auto-tune dismissal is owned by the Rust front.', code: 'RUST_AUTOTUNE_CLEAR_OWNED' });
function refuseOwned(req, res, { parseRequestUrl, json }) {
  const url = parseRequestUrl(req);
  if (!url || url.pathname !== '/api/models/autotune/clear') return false;
  json(res, 503, ROUTE_REFUSAL); return true;
}
module.exports = { OWNED_ROUTES, ROUTE_REFUSAL, refuseOwned };
