'use strict';
const { trustedFront } = require('./trusted-front.cjs');
const PREFIX = '/internal/calibration-routes/';
const MAX_BYTES = 8 * 1024 * 1024;
const token = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
function valid(ask, op) {
  if (!ask || typeof ask !== 'object' || Array.isArray(ask)) return false;
  const keys = { facts: [], listing: ['model', 'token'], prepare: ['model', 'token', 'rowToken'], launch: ['model', 'token', 'rowToken', 'preparedToken', 'plan'] }[op];
  if (Object.keys(ask).length !== keys.length || Object.keys(ask).some(k => !keys.includes(k))) return false;
  if (op === 'facts') return true;
  if (typeof ask.model !== 'string' || ask.model.length > 4096 || !token(ask.token)) return false;
  if (op !== 'listing' && !token(ask.rowToken)) return false;
  if (op === 'launch' && (!token(ask.preparedToken) || !ask.plan || typeof ask.plan !== 'object' || Array.isArray(ask.plan)
    || Object.keys(ask.plan).sort().join(',') !== 'base,native,promptBudgetSeconds')) return false;
  return true;
}
function createCalibrationRoutesBridge({ secret, json, readJson, calibration, log = message => console.warn(message) }) {
  return async function handle(req, res) {
    const path = String(req.url || '').split('?')[0];
    if (!path.startsWith(PREFIX) || !['facts', 'listing', 'prepare', 'launch'].includes(path.slice(PREFIX.length))) return false;
    if (req.method !== 'POST' || !trustedFront(req, secret) || Object.hasOwn(req.headers, 'x-forwarded-for') || Object.hasOwn(req.headers, 'x-noevia-client-ip')) {
      json(res, 404, { error: 'Not found' }); return true;
    }
    const op = path.slice(PREFIX.length);
    let ask;
    try { ask = await readJson(req, 65536); } catch { json(res, 400, { error: 'invalid JSON' }); return true; }
    if (!valid(ask, op)) { json(res, 400, { error: 'Invalid calibration state request.' }); return true; }
    const controller = new AbortController();
    if (req.aborted) controller.abort();
    const disconnect = () => { if (!res.writableEnded) controller.abort(); };
    const aborted = () => controller.abort();
    res.once('close', disconnect); req.once('aborted', aborted);
    // Bounded even if the authenticated front disappears without a clean close event.
    const timer = setTimeout(aborted, 14000); timer.unref?.();
    try {
      const live = calibration();
      if (!live) { json(res, 200, { available: false }); return true; }
      if (!['stateFacts', 'listingFacts', 'preparationFacts', 'compareAndLaunch'].every(key => typeof live[key] === 'function')) throw Error('unsupported actor');
      const options = { signal: controller.signal };
      let result;
      if (op === 'facts') result = live.stateFacts();
      else if (op === 'listing') result = await live.listingFacts(ask.model, ask.token, options);
      else if (op === 'prepare') result = await live.preparationFacts(ask.model, ask.token, ask.rowToken, options);
      else result = await live.compareAndLaunch(ask, options);
      const answer = { available: true, ...result };
      if (Buffer.byteLength(JSON.stringify(answer)) > MAX_BYTES) throw Error('facts over cap');
      if (!controller.signal.aborted) json(res, 200, answer);
    } catch {
      // Fixed source label only: no engine messages, configuration, model names or secrets.
      log('[calibration-routes] state operation failed');
      if (!controller.signal.aborted) json(res, 503, { error: 'Calibration state is unavailable.' });
    } finally {
      clearTimeout(timer); res.removeListener('close', disconnect); req.removeListener('aborted', aborted);
    }
    return true;
  };
}
module.exports = { createCalibrationRoutesBridge, PREFIX, MAX_BYTES };
