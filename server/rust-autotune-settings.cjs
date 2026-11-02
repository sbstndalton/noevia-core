'use strict';
// #2287: Rust owns every method of the settings path; the tune script keeps its one state writer.
const OWNED_ROUTES = Object.freeze(new Set(['ALL /api/models/autotune/settings']));
const ROUTE_REFUSAL = Object.freeze({ error: 'Auto-tune settings are owned by the Rust front.', code: 'RUST_AUTOTUNE_SETTINGS_OWNED' });
function refuseOwned(req, res, { parseRequestUrl, json }) {
  const url = parseRequestUrl(req);
  if (!url || url.pathname !== '/api/models/autotune/settings') return false;
  json(res, 503, ROUTE_REFUSAL); return true;
}
module.exports = { OWNED_ROUTES, ROUTE_REFUSAL, refuseOwned };
