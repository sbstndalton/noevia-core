'use strict';
// GET  /api/features                 -> { flags }            any signed-in user (booleans only)
// GET  /api/admin/features           -> { features }         admin
// PUT  /api/admin/features/:name     { enabled } -> feature  admin
// GET|PUT|DELETE /api/admin/decision-settings (PUT {reset:true} = DELETE: back to the deployment's URL) admin
// Returns true when it handled the request. CSRF/origin checks run before routes are mounted.
function createFeatureRoutes({ features, json, readJson, decisionSettings = null }) {
  return async function featureRoutes(req, res, { path, authn }) {
    if (path === '/api/features') {
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' }), true;
      return json(res, 200, { flags: features.flags() }), true;
    }
    if (path === '/api/admin/decision-settings' || path === '/api/admin/decision-settings/test') {
      if (!authn || authn.user.role !== 'admin') return json(res,403,{error:'Administrator required'}),true;
      if (!decisionSettings) return json(res,503,{error:'Decision configuration unavailable'}),true;
      if(path.endsWith('/test') ? req.method!=='POST' : !['GET','PUT','DELETE'].includes(req.method)) return json(res,405,{error:'method not allowed'}),true;
      try {
        // #1765: DELETE (or PUT {reset:true}) forgets the URL saved in Settings; the deployment's applies again.
        if(req.method==='DELETE') return json(res,200,decisionSettings.reset(authn.user.id)),true;
        const body=req.method==='PUT' ? await readJson(req) : null;
        if(body && body.reset===true) return json(res,200,decisionSettings.reset(authn.user.id)),true;
        const result=req.method==='GET' ? decisionSettings.get() : path.endsWith('/test') ? await decisionSettings.test(await readJson(req)) : decisionSettings.save(body,authn.user.id);
        return json(res,200,result),true;
      } catch(error) {return json(res,error.status||400,{error:error.status?error.message:'Invalid decision settings',...(error.status&&error.messageId?{errorId:error.messageId}:{})}),true;}
    }
    if (path !== '/api/admin/features' && !path.startsWith('/api/admin/features/')) return false;
    if (!authn || authn.user.role !== 'admin') return json(res, 403, { error: 'Administrator required' }), true;
    if (path === '/api/admin/features') {
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' }), true;
      return json(res, 200, { features: features.describe() }), true;
    }
    // A legacy flag name (e.g. astraReview, renamed plannerReview) is still accepted (a stale client or script).
    const requested = decodeURIComponent(path.slice('/api/admin/features/'.length));
    const name = typeof features.resolve === 'function' ? features.resolve(requested) : requested;
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
