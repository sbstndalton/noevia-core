'use strict';
// #2292: every method of this exact path is the front's; start/status remain Node's.
const OWNED_ROUTES = Object.freeze(new Set(['ALL /api/models/calibration/cancel']));
const ROUTE_REFUSAL = Object.freeze({ error: 'Calibration cancellation is owned by the Rust front.', code: 'RUST_CALIBRATION_CANCEL_OWNED' });
function refuseOwned(req, res, { parseRequestUrl, json }) {
  const url = parseRequestUrl(req);
  if (!url || url.pathname !== '/api/models/calibration/cancel') return false;
  json(res, 503, ROUTE_REFUSAL); return true;
}
module.exports = { OWNED_ROUTES, ROUTE_REFUSAL, refuseOwned };
