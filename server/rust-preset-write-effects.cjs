'use strict';
// After the Rust front's preset editor ran (success or not: the file or the router may have changed), this
// process drops what it caches about models, as routes/models.cjs did around every write under /api/models/.
// Loopback only, with the per-start secret (trusted-front.cjs); nothing of the request is read.
const { trustedFront } = require('./trusted-front.cjs');
const PATH = '/internal/preset-editor/effects';
function createPresetWriteEffects({ secret, json, service }) {
  return async function handle(req, res) {
    if (String(req.url || '').split('?')[0] !== PATH) return false;
    if (req.method !== 'POST' || !trustedFront(req, secret) ||
        Object.hasOwn(req.headers, 'x-forwarded-for') || Object.hasOwn(req.headers, 'x-noevia-client-ip')) {
      json(res, 404, { error: 'Not found' });
      return true;
    }
    for await (const _ of req) { /* the body is not used */ }
    service.modelScanCache.clear();
    service.invalidateModelReads?.();
    json(res, 200, { ok: true });
    return true;
  };
}
module.exports = { createPresetWriteEffects, PATH };
