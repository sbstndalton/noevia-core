'use strict';
// sbstndalton/noevia#2262: what the Rust front's model state reads cannot read for themselves, because only this process has
// it. Reached only by the front's own loopback calls (the same check as its other ones); anything else gets the 404 of an
// unknown path, because with file sharing on this listener is not bound to loopback alone. Deployment-wide facts: no
// workspace is opened and no user is named.
//
//   POST /internal/models/facts {want: 'budget'}
//     -> {budget}   inferenceBudget.get(): the figure this process enforces on loads and in its watchdog. That is the truth
//                   of the setting, not the settings row: a row this process could not read at boot is not being enforced,
//                   and the answer has to say so.
//   POST /internal/models/facts {want: 'installed', ids: string[], scan: boolean, firstLoaded?: string}
//     -> {sidecarNames, sidecarLoaded, scan}   see models.cjs installedFacts
const { trustedFront } = require('./trusted-front.cjs');

const PATH = '/internal/models/facts';
const MAX_IDS = 4096;

function createModelFactsBridge({ secret, inferenceBudget, service, json, readJson, log = (m) => console.warn(m) }) {
  return async function handle(req, res) {
    if (String(req.url || '').split('?')[0] !== PATH) return false;
    if (!trustedFront(req, secret) || req.method !== 'POST') { json(res, 404, { error: 'Not found' }); return true; }
    let body;
    try { body = await readJson(req); } catch { json(res, 400, { error: 'invalid JSON' }); return true; }
    const { want, ids, scan, firstLoaded } = body || {};
    const installed = want === 'installed';
    const validIds = Array.isArray(ids) && ids.length <= MAX_IDS && ids.every((id) => typeof id === 'string');
    if ((want !== 'budget' && !installed) || (installed && (!validIds || (firstLoaded !== undefined && typeof firstLoaded !== 'string')))) {
      json(res, 400, { error: 'A known fact is required.' });
      return true;
    }
    try {
      json(res, 200, installed ? await service.installedFacts({ ids, scan: scan === true, firstLoaded }) : { budget: inferenceBudget.get() });
    } catch (e) {
      log(`[models] facts failed: ${e?.code || e?.name || 'error'}`);
      json(res, 503, { error: 'Model facts are unavailable.' });
    }
    return true;
  };
}

module.exports = { createModelFactsBridge, PATH, MAX_IDS };
