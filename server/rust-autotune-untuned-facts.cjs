'use strict';
const { trustedFront } = require('./trusted-front.cjs');
const PATH = '/internal/autotune-untuned/facts';
const MAX_BYTES = 4 * 1024 * 1024;
function createAutotuneUntunedFacts({ secret, json, readJson, autotune }) {
  return async function handle(req, res) {
    if (String(req.url || '').split('?')[0] !== PATH) return false;
    if (req.method !== 'POST' || !trustedFront(req, secret) || Object.hasOwn(req.headers, 'x-forwarded-for') || Object.hasOwn(req.headers, 'x-noevia-client-ip')) { json(res, 404, { error: 'Not found' }); return true; }
    let ask; try { ask = await readJson(req, 64); } catch { json(res, 400, { error: 'invalid JSON' }); return true; }
    if (!ask || typeof ask !== 'object' || Array.isArray(ask) || Object.keys(ask).length !== 1 || typeof ask.scan !== 'boolean') { json(res, 400, { error: 'Invalid scan facts request.' }); return true; }
    const live = autotune();
    if (!live) { json(res, 200, { available: false }); return true; }
    if (!ask.scan) { json(res, 200, { available: true }); return true; }
    const controller = new AbortController();
    const cancel = () => controller.abort();
    req.once?.('aborted', cancel); res.once?.('close', cancel);
    const timer = setTimeout(cancel, 4500); timer.unref?.();
    try {
      if (typeof live.scanFacts !== 'function') throw Error('unsupported owner');
      const facts = await live.scanFacts({ signal: controller.signal });
      controller.signal.throwIfAborted();
      const answer = { available: true, ...facts };
      if (Buffer.byteLength(JSON.stringify(answer)) > MAX_BYTES) throw Error('facts cap');
      json(res, 200, answer);
    } catch (error) {
      // Only two fixed producer reasons cross the wire; never error text, URLs or stack.
      const failure = error?.publicMessage === 'The model server is not responding.' ? 'router'
        : error?.publicMessage === 'Model identity could not be read.' ? 'identity' : 'unavailable';
      json(res, 503, { failure });
    } finally { clearTimeout(timer); req.removeListener?.('aborted', cancel); res.removeListener?.('close', cancel); }
    return true;
  };
}
module.exports = { createAutotuneUntunedFacts, PATH, MAX_BYTES };
