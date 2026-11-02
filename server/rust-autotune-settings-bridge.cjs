'use strict';
const { trustedFront } = require('./trusted-front.cjs');
const PREFIX = '/internal/autotune-settings/';
const MAX_BYTES = 8 * 1024 * 1024;
function createAutotuneSettingsBridge({ secret, json, readJson, tuner, log = m => console.warn(m) }) {
  return async function handle(req, res) {
    const path = String(req.url || '').split('?')[0];
    if (path !== PREFIX + 'facts' && path !== PREFIX + 'commit') return false;
    if (req.method !== 'POST' || !trustedFront(req, secret) || Object.hasOwn(req.headers, 'x-forwarded-for') || Object.hasOwn(req.headers, 'x-noevia-client-ip')) { json(res, 404, { error: 'Not found' }); return true; }
    let ask;
    try { ask = await readJson(req, 4096); } catch { json(res, 400, { error: 'invalid JSON' }); return true; }
    const commit = path.endsWith('/commit');
    const keys = commit ? ['model', 'allowQ5Kv', 'token'] : ['model'];
    if (!ask || typeof ask !== 'object' || Array.isArray(ask) || Object.keys(ask).some(k => !keys.includes(k)) || (ask.model !== undefined && (typeof ask.model !== 'string' || !ask.model || ask.model.length > 200)) || (commit && (!ask.model || typeof ask.allowQ5Kv !== 'boolean' || !/^[0-9a-f]{64}$/.test(ask.token || '')))) {
      json(res, 400, { error: 'Invalid settings state request.' }); return true;
    }
    try {
      const live = tuner();
      const available = !!live;
      const settingsAvailable = typeof live?.settingsFacts === 'function' && typeof live?.commitSettings === 'function';
      let answer = { available, settingsAvailable };
      if (settingsAvailable && ask.model !== undefined) {
        // No await between checking the fingerprint, changing this one map entry and copying facts.
        answer = commit ? live.commitSettings(ask.model, ask.allowQ5Kv, ask.token) : { ...answer, facts: live.settingsFacts(ask.model) };
      } else if (commit) { json(res, 409, { applied: false }); return true; }
      if (Buffer.byteLength(JSON.stringify(answer)) > MAX_BYTES) throw Error('facts over cap');
      json(res, commit && answer.applied === false ? 409 : 200, answer);
    } catch (error) {
      log(`[autotune-settings] state request failed: ${error?.code || error?.name || 'error'}`);
      json(res, 503, { error: 'Auto-tune state is unavailable.' });
    }
    return true;
  };
}
module.exports = { createAutotuneSettingsBridge, PREFIX, MAX_BYTES };
