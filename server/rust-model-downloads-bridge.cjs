'use strict';
// Rust port track R11: with NOEVIA_RUST_MODEL_WRITES=rust the Rust front answers POST /api/models/pull (noevia-rs
// bins/noevia-server model_pull_routes.rs over crates/model-pull). The download tracker (its jobs, the state file and the
// event stream the downloads list follows) stays this process's, so the front records its pull here, as the llama.cpp
// manager's own pull does (llamacpp-manager.cjs `pull`: requested before the router call, rejected after a refused one):
//
//   POST /internal/models/downloads/requested {model}  -> 200 {ok:true}   tracker.requested(model) (and its connect)
//   POST /internal/models/downloads/rejected  {model}  -> 200 {ok:true}   tracker.rejected(model)
//        404 when this server has no download tracker (not the llama.cpp manager); 400 for a body without a model.
//
// Reached only by the front's own loopback calls (trusted-front.cjs); anything else gets the 404 of an unknown path.
const { trustedFront } = require('./trusted-front.cjs');

const PREFIX = '/internal/models/downloads/';
const OPS = Object.freeze(['requested', 'rejected']);
const MAX_MODEL = 512;

function createDownloadsBridge({ secret, json, readJson, modelManager }) {
  return async function handle(req, res) {
    const path = String(req.url || '').split('?')[0];
    if (!path.startsWith(PREFIX)) return false;
    const op = path.slice(PREFIX.length);
    if (!OPS.includes(op) || req.method !== 'POST' || !trustedFront(req, secret)
      || Object.hasOwn(req.headers, 'x-forwarded-for') || Object.hasOwn(req.headers, 'x-noevia-client-ip')) {
      json(res, 404, { error: 'Not found' });
      return true;
    }
    let body;
    try { body = await readJson(req, 4096); } catch { json(res, 400, { error: 'invalid JSON' }); return true; }
    const model = body && typeof body === 'object' && !Array.isArray(body) ? body.model : undefined;
    if (typeof model !== 'string' || !model || model.length > MAX_MODEL || Object.keys(body).length !== 1) {
      json(res, 400, { error: 'A model is required.' });
      return true;
    }
    const track = modelManager?.trackDownload;
    if (!track || typeof track[op] !== 'function') { json(res, 404, { error: 'This server has no download tracker.' }); return true; }
    track[op](model);
    json(res, 200, { ok: true });
    return true;
  };
}

module.exports = { PREFIX, OPS, createDownloadsBridge };
