'use strict';
const { trustedFront } = require('./trusted-front.cjs');
const PREFIX = '/internal/calibration-cancel/';
const MAX_BYTES = 8 * 1024 * 1024;
function createCalibrationCancelBridge({ secret, json, readJson, calibration, log = m => console.warn(m) }) {
  return async function handle(req, res) {
    const path = String(req.url || '').split('?')[0];
    if (path !== PREFIX + 'facts' && path !== PREFIX + 'abort') return false;
    if (req.method !== 'POST' || !trustedFront(req, secret) || Object.hasOwn(req.headers, 'x-forwarded-for') || Object.hasOwn(req.headers, 'x-noevia-client-ip')) { json(res, 404, { error: 'Not found' }); return true; }
    let ask;
    try { ask = await readJson(req, 4096); } catch { json(res, 400, { error: 'invalid JSON' }); return true; }
    const abort = path.endsWith('/abort');
    if (!ask || typeof ask !== 'object' || Array.isArray(ask) || Object.keys(ask).some(k => k !== 'token') || (abort ? typeof ask.token !== 'string' || !/^[0-9a-f]{64}$/.test(ask.token) : Object.hasOwn(ask, 'token'))) { json(res, 400, { error: 'Invalid cancellation state request.' }); return true; }
    try {
      const live = calibration();
      const available = !!live;
      const capable = typeof live?.cancellationFacts === 'function' && typeof live?.compareAndAbort === 'function';
      if (available && !capable) throw Error('actor does not support snapshots');
      const answer = available ? (abort ? live.compareAndAbort(ask.token) : { available, ...live.cancellationFacts() }) : { available };
      if (Buffer.byteLength(JSON.stringify(answer)) > MAX_BYTES) throw Error('facts over cap');
      json(res, abort && answer.applied === false ? 409 : 200, answer);
    } catch (error) {
      log(`[calibration-cancel] state request failed: ${error?.code || error?.name || 'error'}`);
      json(res, 503, { error: 'Calibration state is unavailable.' });
    }
    return true;
  };
}
module.exports = { createCalibrationCancelBridge, PREFIX, MAX_BYTES };
