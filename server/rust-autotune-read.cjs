'use strict';
const OWNED_ROUTES = Object.freeze(new Set(['GET /api/models/autotune']));
const ROUTE_REFUSAL = { error: 'The Rust front owns auto-tune status.' };
function refuseOwned(req, res, { parseRequestUrl, json }) {
  if (req.method !== 'GET' || parseRequestUrl(req).pathname !== '/api/models/autotune') return false;
  json(res, 503, ROUTE_REFUSAL); return true;
}
module.exports = { OWNED_ROUTES, ROUTE_REFUSAL, refuseOwned };
