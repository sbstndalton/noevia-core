'use strict';
// GET  /api/features                 -> { flags }            any signed-in user (booleans only)
// GET  /api/admin/features           -> { features }         admin
// PUT  /api/admin/features/:name     { enabled } -> feature  admin
// Returns true when it handled the request. CSRF/origin checks run before routes are mounted.
function createFeatureRoutes({ features, json, readJson }) {
  return async function featureRoutes(req, res, { path, authn }) {
    if (path === '/api/features') {
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' }), true;
      return json(res, 200, { flags: features.flags() }), true;
    }
    if (path !== '/api/admin/features' && !path.startsWith('/api/admin/features/')) return false;
    if (!authn || authn.user.role !== 'admin') return json(res, 403, { error: 'Administrator required' }), true;
    if (path === '/api/admin/features') {
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' }), true;
      return json(res, 200, { features: features.describe() }), true;
    }
    const name = decodeURIComponent(path.slice('/api/admin/features/'.length));
    if (req.method !== 'PUT') return json(res, 405, { error: 'method not allowed' }), true;
    let body;
    try { body = await readJson(req); } catch { return json(res, 400, { error: 'invalid JSON' }), true; }
    try {
      features.set(name, body?.enabled, authn.user.id);
      return json(res, 200, features.describe().find(f => f.name === name)), true;
    } catch (error) {
      return json(res, error.status || 500, { error: error.status ? error.message : 'Could not save the feature' }), true;
    }
  };
}
module.exports = { createFeatureRoutes };
