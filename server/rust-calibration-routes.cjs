'use strict';
// sbstndalton/noevia#2303: the calibration job itself (native-calibration-<hash>.json, boot recovery, its hold)
// is the Rust front's (--features rust-calibration-worker). This process builds no public calibrator and does
// not recover the job at boot; release assembly and the web supervisor pair the two by this marker.
const CALIBRATION_WORKER_OWNER = 'noevia-calibration-worker-rust/1';
const OWNED_ROUTES = Object.freeze(new Set(['ALL /api/models/calibration']));
const ROUTE_REFUSAL = Object.freeze({ error: 'Calibration is owned by the Rust front.', code: 'RUST_CALIBRATION_OWNED' });
function refuseOwned(req, res, { parseRequestUrl, json }) {
  if (parseRequestUrl(req)?.pathname !== '/api/models/calibration') return false;
  json(res, 503, ROUTE_REFUSAL); return true;
}
module.exports = { CALIBRATION_WORKER_OWNER, OWNED_ROUTES, ROUTE_REFUSAL, refuseOwned };
