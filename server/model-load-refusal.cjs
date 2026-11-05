'use strict';
// sbstndalton/noevia#2303: the Rust front runs the calibration job, and every load it asks the engine for is
// first decided here. Node's own calibrator sent each POST /models/load through llamacpp-manager's request
// closure, which refuses what overBudget() refuses: a size knob that is not a whole number (invalid_size), a
// model the memory watchdog quarantined for this preset revision and budget (inference_budget_unloaded), an
// estimated footprint over the inference memory budget (inference_budget). The front asks this process for that
// same decision, over the models.ini and budget current at the moment it asks, instead of re-deriving it.
//
//   POST /internal/model-maintenance/load-refusal   body {model}   200 {refusal: null | {error, code, ...}}
//
// `refusal` is exactly the body Node's request closure answers its 409 with. A body that is not {model: <name>}
// is a 400, a decision that throws is a 503. Only the front may ask (trusted-front.cjs: loopback, not proxied, the
// per-start secret); anything else, and a manager with no load decision, is the 404 of an unknown path. The front
// treats every answer but a 200 as a refusal: no load without a decision.
const { trustedFront } = require('./trusted-front.cjs');

const PATH = '/internal/model-maintenance/load-refusal';
const BODY_LIMIT = 4096;
const MODEL_LIMIT = 512;

/** The asked model, or null when the body is not `{model: <non-empty string>}`. Bounded in size and time. */
function readModel(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0, done = false;
    const finish = (value) => { if (!done) { done = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => finish(null), 10000);
    timer.unref?.();
    req.on('data', (chunk) => { size += chunk.length; if (size > BODY_LIMIT) { finish(null); req.resume(); } else chunks.push(chunk); });
    req.on('error', () => finish(null));
    req.on('end', () => {
      let ask;
      try { ask = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return finish(null); }
      if (!ask || typeof ask !== 'object' || Array.isArray(ask) || Object.keys(ask).some((k) => k !== 'model')) return finish(null);
      const { model } = ask;
      finish(typeof model === 'string' && model.length > 0 && model.length <= MODEL_LIMIT ? model : null);
    });
  });
}

/** The route, answered before authentication and the request gate. True when it was this route's. */
function createLoadRefusalRoute({ secret, json, loadRefusal }) {
  async function handle(req, res) {
    if (String(req.url || '').split('?')[0] !== PATH) return false;
    if (!trustedFront(req, secret) || typeof loadRefusal !== 'function' || req.method !== 'POST') {
      json(res, 404, { error: 'Not found' });
      return true;
    }
    const model = await readModel(req);
    if (model === null) { json(res, 400, { error: 'model must be a model name.' }); return true; }
    let refusal;
    try { refusal = await loadRefusal(model); } catch { refusal = undefined; }
    if (refusal === null) json(res, 200, { refusal: null });
    else if (refusal && typeof refusal === 'object' && !Array.isArray(refusal)) json(res, 200, { refusal });
    else json(res, 503, { error: 'The load could not be checked against the inference memory budget.' });
    return true;
  }
  return { handle };
}

module.exports = { createLoadRefusalRoute, PATH };
