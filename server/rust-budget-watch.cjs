'use strict';
// #697 runtime safety net, now the Rust front's (--features rust-budget-watch-v2, noevia-rs
// bins/noevia-server/src/model_maint/budget_watch.rs). The front samples the inference memory every
// interval, keeps the strikes, the idle baseline and the cooldown, and unloads through the inference
// gate exactly as inference-budget-watch.cjs did here. This process no longer starts that watch;
// release assembly and the web supervisor pair the two by BUDGET_WATCH_OWNER, so there is never a
// double run (both sampling and unloading) or no run at all.
//
// What only this process has stays here and is reached by the front's own loopback call (the same
// check as its other ones, trusted-front.cjs); anything else gets the 404 of an unknown path:
//
//   POST /internal/budget-watch {want: 'held'}
//     -> {held}   modelManager.maintenanceHeld(): a calibration, auto-tune or sweep holds the
//                 maintenance gate (this process's own, or one observed at the inference gate), so
//                 no idle baseline may be taken (#873).
//   POST /internal/budget-watch {want: 'quarantine', model, budgetGib}
//     -> {ok}     modelManager.quarantine(model, budgetGib): the model the front unloaded stays
//                 refused on the next load until its preset revision or the budget changes (the
//                 load guard that reads it, overBudget, is this process's).
//
// The budget itself is the existing facts call (rust-model-facts.cjs {want: 'budget'}).
const { trustedFront } = require('./trusted-front.cjs');

const BUDGET_WATCH_OWNER = 'noevia-budget-watch-rust/2';
const PATH = '/internal/budget-watch';
// A model id the router lists; the pairing limit the front already applies to router ids.
const MAX_MODEL_BYTES = 512;

function createBudgetWatchBridge({ secret, modelManager, json, readJson, log = (m) => console.warn(m) }) {
  return async function handle(req, res) {
    if (String(req.url || '').split('?')[0] !== PATH) return false;
    if (!trustedFront(req, secret) || req.method !== 'POST') { json(res, 404, { error: 'Not found' }); return true; }
    let body;
    try { body = await readJson(req); } catch { json(res, 400, { error: 'invalid JSON' }); return true; }
    const { want, model, budgetGib } = body || {};
    if (want === 'held') {
      let held;
      try { held = modelManager.maintenanceHeld?.() === true; } catch (e) {
        log(`[inference-budget] held fact failed: ${e?.code || e?.name || 'error'}`);
        json(res, 503, { error: 'The maintenance state is unavailable.' });
        return true;
      }
      json(res, 200, { held });
      return true;
    }
    if (want === 'quarantine') {
      const validModel = typeof model === 'string' && model.length > 0 && Buffer.byteLength(model, 'utf8') <= MAX_MODEL_BYTES;
      const validBudget = typeof budgetGib === 'number' && Number.isFinite(budgetGib) && budgetGib > 0;
      if (!validModel || !validBudget) { json(res, 400, { error: 'A model and a budget are required.' }); return true; }
      if (typeof modelManager.quarantine !== 'function') { json(res, 200, { ok: false }); return true; }
      try {
        if (Object.hasOwn(body, 'revision')) {
          if (body.revision !== null && (typeof body.revision !== 'string' || !/^[a-f0-9]{64}$/.test(body.revision))) { json(res, 400, { error: 'Invalid revision.' }); return true; }
          if (typeof modelManager.acknowledgeQuarantine !== 'function') { json(res, 200, { ok: false }); return true; }
          json(res, 200, modelManager.acknowledgeQuarantine(model, budgetGib, body.revision));
          return true;
        }
        modelManager.quarantine(model, budgetGib);
      } catch (e) {
        log(`[inference-budget] quarantine failed: ${e?.code || e?.name || 'error'}`);
        json(res, 503, { error: 'The quarantine is unavailable.' });
        return true;
      }
      json(res, 200, { ok: true });
      return true;
    }
    json(res, 400, { error: 'A known fact is required.' });
    return true;
  };
}

module.exports = { BUDGET_WATCH_OWNER, PATH, MAX_MODEL_BYTES, createBudgetWatchBridge };
