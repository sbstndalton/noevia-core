'use strict';
// #778 routing modes (features.routingModes):
//   GET /api/routing-mode   -> { enabled, mode, storedMode, whenSensitive, cloud, allowed, admin }
//     `mode` is the mode replies actually use (a mode an administrator has since disallowed reads
//     as 'local', see effectiveMode); `storedMode` is the account's own saved choice.
//   PUT /api/routing-mode   { mode, whenSensitive, cloud }   this account's own setting
//   PUT /api/routing-mode/allowed { allowed: [...] }         administrators only
//
// Returns true when it handled the request. Auth and CSRF run before routes are mounted. The
// account setting lives in the requesting user's own workspace directory; the allowed list in the
// settings table. With the flag off, GET answers { enabled: false } and PUT is refused.

const PASS = Symbol('unhandled');

/**
 * @param {object} deps
 * @param {(res, status, body) => any} deps.json
 * @param {(req) => Promise<string>} deps.readBody
 * @param {() => boolean} deps.enabled
 * @param {() => { dir: string }} deps.currentWorkspace
 * @param {{ get: (k:string) => string|undefined, set: (k:string, v:string) => void }} deps.store
 * @param {(action:string, actor:string, detail:object) => void} [deps.audit]
 */
function createRoutingModeRoutes({ json, readBody, enabled, currentWorkspace, store, audit = () => {} }) {
  const rm = require('../routing-modes.cjs');
  async function readJsonBody(req, res) {
    try { return JSON.parse(await readBody(req)); } catch { json(res, 400, { error: 'invalid JSON' }); return PASS; }
  }
  const view = (stored, allowed, admin) => ({ enabled: true, ...stored, mode: rm.effectiveMode(stored, allowed), storedMode: stored.mode, allowed, admin });
  async function handle(req, res, { path: p, authn }) {
    if (p !== '/api/routing-mode' && p !== '/api/routing-mode/allowed') return PASS;
    const admin = authn?.user?.role === 'admin';
    if (p === '/api/routing-mode' && req.method === 'GET') {
      if (enabled() !== true) return json(res, 200, { enabled: false });
      return json(res, 200, view(rm.read(currentWorkspace().dir), rm.allowedModes(store), admin));
    }
    if (req.method !== 'PUT') return json(res, 405, { error: 'Method not allowed' });
    if (enabled() !== true) return json(res, 409, { error: 'Routing modes are turned off on this server.' });
    const body = await readJsonBody(req, res);
    if (body === PASS) return true;
    try {
      if (p === '/api/routing-mode/allowed') {
        if (!admin) return json(res, 403, { error: 'Administrator required' });
        const allowed = rm.setAllowedModes(store, body?.allowed);
        audit('routing.allowed', authn.user.id, { allowed });
        return json(res, 200, { allowed });
      }
      const next = rm.validate(body, rm.allowedModes(store));
      if (next.mode === 'cloud' && !(next.cloud.providerId && rm.cloudModel(next.cloud, 'smart'))) {
        return json(res, 400, { error: 'Cloud routing needs a cloud provider and at least one model.' });
      }
      rm.write(currentWorkspace().dir, next);
      return json(res, 200, view(next, rm.allowedModes(store), admin));
    } catch (error) {
      return json(res, error.status || 400, { error: error.message });
    }
  }
  return async function routingModeRoutes(req, res, ctx) {
    return (await handle(req, res, ctx)) !== PASS;
  };
}

module.exports = { createRoutingModeRoutes };
