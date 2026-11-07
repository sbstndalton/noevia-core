'use strict';
// F1: Rust is the only per-user roles writer. This bridge supplies live facts and
// invokes the existing warming trigger; it never accepts roles or writes them.
const RUST_AUTO_ROLES_WRITE_OWNED = 'rust-auto-roles-write';
const { trustedFront } = require('./trusted-front.cjs');
const ROUTE_REFUSAL = Object.freeze({ error: 'The auto-roles write is owned by the Rust front.', code: 'RUST_AUTO_ROLES_WRITE_OWNED' });
const owned = (method, pathname) => method === 'PUT' && pathname === '/api/auto-roles';
function refuseOwned(req, res, { parseRequestUrl, json }) {
  const url = parseRequestUrl(req, `http://${req.headers.host || 'localhost'}`) || parseRequestUrl(req);
  if (!url || !owned(req.method, url.pathname)) return false;
  json(res, 503, ROUTE_REFUSAL); return true;
}
function createBridge({ secret, json, readJson, service, asUser, user }) {
  return async (req, res) => {
    const path = String(req.url || '').split('?')[0];
    if (!['/internal/auto-roles/facts', '/internal/auto-roles/invalidate', '/internal/auto-roles/warm'].includes(path)) return false;
    if (req.method !== 'POST' || !trustedFront(req, secret) || Object.hasOwn(req.headers, 'x-forwarded-for') || Object.hasOwn(req.headers, 'x-noevia-client-ip')) { json(res, 404, { error: 'Not found' }); return true; }
    let ask;
    try { ask = await readJson(req, 8192); } catch { json(res, 400, { error: 'invalid JSON' }); return true; }
    const warm = path.endsWith('/warm');
    if (!ask || typeof ask !== 'object' || Array.isArray(ask) || Object.keys(ask).some(k => !warm || k !== 'user') || (warm && (Object.keys(ask).length !== 1 || typeof ask.user !== 'string'))) { json(res, 400, { error: 'Invalid auto-roles operation.' }); return true; }
    try {
      if (path.endsWith('/facts')) json(res, 200, { catalogue: await service.servedCatalogue() });
      else if (warm) {
        // Recheck the live account: a role changed since the front's gate must not warm.
        if (user(ask.user)?.role !== 'admin') { json(res, 403, { error: 'administrator required' }); return true; }
        asUser(ask.user, () => service.ensureRolesLoaded());
        json(res, 200, { ok: true });
      } else { service.invalidateModelReads(); json(res, 200, { ok: true }); }
    } catch { json(res, 503, { error: 'Auto-roles state is unavailable.' }); }
    return true;
  };
}
module.exports = { RUST_AUTO_ROLES_WRITE_OWNED, ROUTE_REFUSAL, owned, refuseOwned, createBridge };
