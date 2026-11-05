'use strict';
// After the Rust front's preset editor ran (success or not: the file or the router may have changed), this
// process drops what it caches about models, as routes/models.cjs did around every write under /api/models/.
// Loopback only, with the per-start secret (trusted-front.cjs). The call is independent of its body: the caches
// are dropped first, the body is never collected, and a request that streams more than MAX_BODY bytes or
// stays open past BODY_MS is cut off, so no trusted caller can hold this handler open (D2 review P3).
const { trustedFront } = require('./trusted-front.cjs');
const PATH = '/internal/preset-editor/effects';
const MAX_BODY = 4096;
const BODY_MS = 3000;
function createPresetWriteEffects({ secret, json, service }) {
  return async function handle(req, res) {
    if (String(req.url || '').split('?')[0] !== PATH) return false;
    if (req.method !== 'POST' || !trustedFront(req, secret) ||
        Object.hasOwn(req.headers, 'x-forwarded-for') || Object.hasOwn(req.headers, 'x-noevia-client-ip')) {
      json(res, 404, { error: 'Not found' });
      return true;
    }
    service.modelScanCache.clear();
    service.invalidateModelReads?.();
    // Bound what the connection may still send after the answer: count the bytes, never keep them.
    let seen = 0;
    const cut = () => { try { req.destroy?.(); } catch { /* already gone */ } };
    req.on?.('data', (chunk) => { seen += chunk.length; if (seen > MAX_BODY) cut(); });
    req.on?.('error', () => {});
    const timer = setTimeout(cut, BODY_MS);
    timer.unref?.();
    res.once?.('close', () => clearTimeout(timer));
    try { res.setHeader?.('Connection', 'close'); } catch { /* headers already sent */ }
    json(res, 200, { ok: true });
    return true;
  };
}
module.exports = { createPresetWriteEffects, PATH, MAX_BODY, BODY_MS };
