'use strict';
const { trustedFront } = require('./trusted-front.cjs');
const PATH = '/internal/idle-unload-read/facts';
function createIdleUnloadFacts({ secret, json, effectiveSeconds }) {
  return async function handle(req, res) {
    if (req.url !== PATH) return false;
    if (req.method !== 'POST' || !trustedFront(req, secret) || Object.hasOwn(req.headers, 'x-forwarded-for') || Object.hasOwn(req.headers, 'x-noevia-client-ip')) {
      json(res, 404, { error: 'Not found' });
      return true;
    }
    let seconds = null;
    try { seconds = await effectiveSeconds(); } catch { /* The effective preset is unknown. */ }
    json(res, 200, { seconds: Number.isInteger(seconds) && seconds >= 0 ? seconds : null });
    return true;
  };
}
module.exports = { createIdleUnloadFacts, PATH };
