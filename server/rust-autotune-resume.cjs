'use strict';
const OWNED_ROUTES = Object.freeze(new Set(['ALL /api/models/autotune/resume']));
const ROUTE_REFUSAL = { error: 'The Rust front owns auto-tune resume.' };
function refuseOwned(req, res, { parseRequestUrl, json }) {
  if (parseRequestUrl(req).pathname !== '/api/models/autotune/resume') return false;
  json(res, 503, ROUTE_REFUSAL); return true;
}
module.exports = { OWNED_ROUTES, ROUTE_REFUSAL, refuseOwned };
