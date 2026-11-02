'use strict';
const { trustedFront } = require('./trusted-front.cjs');
const PREFIX = '/internal/autotune-clear/';
const MAX_BYTES = 8192;
function createAutotuneClearBridge({ secret, json, readJson, autotune, log = m => console.warn(m) }) {
  return async function handle(req, res) {
    const path = String(req.url || '').split('?')[0];
    if (path !== PREFIX + 'facts' && path !== PREFIX + 'clear') return false;
    if (req.method !== 'POST' || !trustedFront(req, secret) || Object.hasOwn(req.headers, 'x-forwarded-for') || Object.hasOwn(req.headers, 'x-noevia-client-ip')) { json(res, 404, { error: 'Not found' }); return true; }
    let ask;
    try { ask = await readJson(req, 4096); } catch { json(res, 400, { error: 'invalid JSON' }); return true; }
    const clear = path.endsWith('/clear');
    if (!ask || typeof ask !== 'object' || Array.isArray(ask) || Object.keys(ask).some(k => k !== 'token') || (clear ? typeof ask.token !== 'string' || !/^[0-9a-f]{64}$/.test(ask.token) : Object.hasOwn(ask, 'token'))) { json(res, 400, { error: 'Invalid dismissal state request.' }); return true; }
    try {
      const live = autotune();
      const available = !!live;
      const capable = typeof live?.clearFacts === 'function' && typeof live?.compareAndClear === 'function';
      if (available && !capable) throw Error('actor does not support snapshots');
      const answer = available ? (clear ? live.compareAndClear(ask.token) : { available, ...live.clearFacts() }) : { available };
      if (Buffer.byteLength(JSON.stringify(answer)) > MAX_BYTES) throw Error('facts over cap');
      json(res, clear && answer.applied === false ? 409 : 200, answer);
    } catch (error) {
      log('[autotune-clear] state request failed');
      json(res, 503, { error: 'Auto-tune state is unavailable.' });
    }
    return true;
  };
}
module.exports = { createAutotuneClearBridge, PREFIX, MAX_BYTES };
