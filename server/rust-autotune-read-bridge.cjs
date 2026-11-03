'use strict';
const { trustedFront } = require('./trusted-front.cjs');
const PATH = '/internal/autotune-read/facts';
const MAX_BYTES = 8 * 1024 * 1024;
function createAutotuneReadBridge({ secret, json, readJson, autotune, log = m => console.warn(m) }) {
  return async function handle(req, res) {
    if (String(req.url || '').split('?')[0] !== PATH) return false;
    if (req.method !== 'POST' || !trustedFront(req, secret) || Object.hasOwn(req.headers, 'x-forwarded-for') || Object.hasOwn(req.headers, 'x-noevia-client-ip')) { json(res, 404, { error: 'Not found' }); return true; }
    let ask;
    try { ask = await readJson(req, 1024 * 1024); } catch { json(res, 400, { error: 'invalid JSON' }); return true; }
    if (!ask || typeof ask !== 'object' || Array.isArray(ask) || Object.keys(ask).some(k => k !== 'keys') || !Array.isArray(ask.keys) || ask.keys.length > 2 || ask.keys.some(k => typeof k !== 'string' || k.length > 65536)) { json(res, 400, { error: 'Invalid status facts request.' }); return true; }
    try {
      const live = autotune();
      if (live && typeof live.statusFacts !== 'function') throw Error('actor unavailable');
      const answer = live ? { available: true, ...live.statusFacts(ask.keys) } : { available: false };
      if (Buffer.byteLength(JSON.stringify(answer)) > MAX_BYTES) throw Error('facts over cap');
      json(res, 200, answer);
    } catch {
      log('[autotune-read] state request failed');
      json(res, 503, { error: 'Auto-tune state is unavailable.' });
    }
    return true;
  };
}
module.exports = { createAutotuneReadBridge, PATH, MAX_BYTES };
