'use strict';
// Notifications to the remaining Node consumers. Selection/deletion/reload policy lives in Rust.
const { trustedFront } = require('./trusted-front.cjs');
const PATH = '/internal/model-writes/effects';
const MODEL_WRITES_OWNER = 'rust-model-writes-d-v1';
function createModelWriteEffects({ secret, json, readJson, service, manager, asUser }) {
  return async (req, res) => {
    if (req.url !== PATH) return false;
    if (req.method !== 'POST' || !trustedFront(req, secret) || Object.hasOwn(req.headers, 'x-forwarded-for') || Object.hasOwn(req.headers, 'x-noevia-client-ip')) {
      json(res,404,{error:'Not found'}); return true;
    }
    let body;
    try { body = await readJson(req); } catch { json(res,400,{error:'invalid JSON'}); return true; }
    if (!body || !['invalidate','removed'].includes(body.op) || (body.op === 'removed' && (!Array.isArray(body.names) || body.names.length > 4096 || !body.names.every(n => typeof n === 'string') || typeof body.user !== 'string' || !body.user || body.user.length > 128))) {
      json(res,400,{error:'Invalid notification'}); return true;
    }
    if (body.op === 'removed') await asUser(body.user, () => { for (const name of body.names) {
      service.clearRoleReferences(name);
      if (service.lastLoadedModel() === name) service.clearLastLoadedModel(name);
      manager.forgetIdentity?.(name);
    } });
    service.modelScanCache.clear();
    service.invalidateModelReads?.();
    json(res,200,{ok:true}); return true;
  };
}
module.exports = { createModelWriteEffects, PATH, MODEL_WRITES_OWNER };
