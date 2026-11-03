'use strict';
const { trustedFront } = require('./trusted-front.cjs');
const PREFIX = '/internal/autotune-resume/';
const MAX_BYTES = 8 * 1024 * 1024;
function createAutotuneResumeBridge({ secret, json, readJson, autotune, invalidate = () => {}, log = m => console.warn(m) }) {
  return async function handle(req, res) {
    const path = String(req.url || '').split('?')[0];
    const action = ['facts', 'prepare', 'commit'].find(a => path === PREFIX + a);
    if (!action) return false;
    if (req.method !== 'POST' || !trustedFront(req, secret) || Object.hasOwn(req.headers, 'x-forwarded-for') || Object.hasOwn(req.headers, 'x-noevia-client-ip')) { json(res, 404, { error: 'Not found' }); return true; }
    let ask;
    try { ask = await readJson(req, MAX_BYTES); } catch { json(res, 400, { error: 'invalid JSON' }); return true; }
    const allowed = action === 'facts' ? [] : action === 'prepare' ? ['token', 'stage', 'selectors'] : ['token', 'plan'];
    if (!ask || typeof ask !== 'object' || Array.isArray(ask) || Object.keys(ask).some(k => !allowed.includes(k)) ||
        action !== 'facts' && (typeof ask.token !== 'string' || !/^[0-9a-f]{64}$/.test(ask.token))) { json(res, 400, { error: 'Invalid resume state request.' }); return true; }
    const controller = new AbortController();
    const abort = () => controller.abort();
    const closed = () => { if (!res.writableFinished) abort(); };
    req.once?.('aborted', abort); res.once?.('close', closed);
    try {
      const live = autotune();
      if (live && !['resumeFacts', 'prepareResume', 'compareAndResume'].every(k => typeof live[k] === 'function')) throw Error('actor unavailable');
      const answer = !live ? { available: false } : action === 'facts' ? { available: true, ...live.resumeFacts() }
        : action === 'prepare' ? await live.prepareResume(ask.token, { stage: ask.stage, selectors: ask.selectors }, controller.signal)
        : live.compareAndResume(ask.token, ask.plan);
      if (action === 'commit' && answer.applied === true) invalidate();
      if (Buffer.byteLength(JSON.stringify(answer)) > MAX_BYTES) throw Error('facts over cap');
      json(res, answer.applied === false ? 409 : 200, answer);
    } catch {
      log('[autotune-resume] state request failed');
      json(res, 503, { error: 'Auto-tune state is unavailable.' });
    } finally { req.removeListener?.('aborted', abort); res.removeListener?.('close', closed); }
    return true;
  };
}
module.exports = { createAutotuneResumeBridge, PREFIX, MAX_BYTES };
