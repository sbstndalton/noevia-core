'use strict';
const { trustedFront } = require('./trusted-front.cjs');
const { REGISTRY_PROTOCOL } = require('./rust-approval-registry.cjs');
const PREFIX = '/internal/approvals/revoke';
function createRevocationRoute({ secret, registry, json, readJson }) {
  return async (req, res) => {
    if (String(req.url || '').split('?')[0] !== PREFIX) return false;
    if (req.method !== 'POST' || !trustedFront(req, secret)) { json(res, 404, { error: 'Not found' }); return true; }
    const body = await readJson(req);
    if (body?.protocol !== REGISTRY_PROTOCOL || !registry.frontRevoked(body?.user, body?.chat ?? null)) {
      json(res, 400, { error: 'Invalid revocation' }); return true;
    }
    // No await between the epoch advance and acknowledgement.
    json(res, 200, { acknowledged: true, protocol: REGISTRY_PROTOCOL });
    return true;
  };
}
module.exports = { createRevocationRoute, PREFIX };
