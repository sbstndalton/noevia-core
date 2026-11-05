'use strict';
// Row A (model load/unload, 2026-11-05): POST /api/models/load and POST /api/models/unload are the Rust front's
// (noevia-rs bins/noevia-server model_load_routes.rs). The front takes the load's place in this process's
// admission through the inference-admission lease (the maintenance gate, prepareLoad's budget and the gate's
// queue), runs the router steps itself, and asks this process once, after every write, to drop the model reads
// it shares (the 2 s installed list and the folder scan), as routes/models.cjs did around its own handler.
//
//   POST /internal/models/invalidate   body {}   200 {ok: true}
//
// Only the front may ask (trusted-front.cjs: loopback, not proxied, the per-start secret); anything else is the
// 404 of an unknown path. A public request that reaches this process is a bypass of the front: 503, nothing run.
//
// LOAD_MARKER pairs this Core with a front that carries `noevia-model-load-authority/1` (Top assemble-release.sh).
const { trustedFront } = require('./trusted-front.cjs');

const LOAD_MARKER = 'noevia-model-load-owner/1';
const PATH = '/internal/models/invalidate';
const ROUTE_REFUSAL = Object.freeze({ error: 'Model load and unload are owned by the Rust front.', code: 'RUST_MODEL_LOAD_OWNED' });
const OWNED = new Set(['/api/models/load', '/api/models/unload']);

const owned = (method, pathname) => method === 'POST' && OWNED.has(pathname);

function refuseOwned(req, res, { parseRequestUrl, json }) {
  const url = parseRequestUrl(req);
  if (!url || !owned(req.method, url.pathname)) return false;
  json(res, 503, ROUTE_REFUSAL);
  return true;
}

function createInvalidateBridge({ secret, json, readJson, service }) {
  return async (req, res) => {
    if (String(req.url || '').split('?')[0] !== PATH) return false;
    if (req.method !== 'POST' || !trustedFront(req, secret) || Object.hasOwn(req.headers, 'x-forwarded-for') || Object.hasOwn(req.headers, 'x-noevia-client-ip')) {
      json(res, 404, { error: 'Not found' });
      return true;
    }
    let ask;
    try { ask = await readJson(req, 1024); } catch { json(res, 400, { error: 'invalid JSON' }); return true; }
    if (!ask || typeof ask !== 'object' || Array.isArray(ask) || Object.keys(ask).length) { json(res, 400, { error: 'Invalid invalidation.' }); return true; }
    try {
      service.modelScanCache?.clear?.();
      service.invalidateModelReads?.();
      json(res, 200, { ok: true });
    } catch { json(res, 503, { error: 'Model reads are unavailable.' }); }
    return true;
  };
}

module.exports = { LOAD_MARKER, PATH, ROUTE_REFUSAL, owned, refuseOwned, createInvalidateBridge };
