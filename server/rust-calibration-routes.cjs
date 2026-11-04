'use strict';
const OWNED_ROUTES = Object.freeze(new Set(['ALL /api/models/calibration']));
const ROUTE_REFUSAL = Object.freeze({ error: 'Calibration is owned by the Rust front.', code: 'RUST_CALIBRATION_OWNED' });
function refuseOwned(req, res, { parseRequestUrl, json }) {
  if (parseRequestUrl(req)?.pathname !== '/api/models/calibration') return false;
  json(res, 503, ROUTE_REFUSAL); return true;
}
module.exports = { OWNED_ROUTES, ROUTE_REFUSAL, refuseOwned };
