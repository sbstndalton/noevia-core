'use strict';
// GET  /api/features                 -> { flags }            any signed-in user (booleans only)
// GET  /api/admin/features           -> { features }         admin
// PUT  /api/admin/features/:name     { enabled } -> feature  admin
// GET|PUT|DELETE /api/admin/decision-settings (PUT {reset:true} = DELETE: back to the deployment's URL) admin
// Returns true when it handled the request. CSRF/origin checks run before routes are mounted.
const FEATURE_REFUSAL=Object.freeze({ error:'Feature settings are owned by the Rust front.',code:'RUST_FEATURES_OWNED' });
const owned=path=>path==='/api/features'||path==='/api/admin/features'||path.startsWith('/api/admin/features/');
function refuseOwnedFeatures(req,res,{parseRequestUrl,json}) {
  const url=parseRequestUrl(req,`http://${req.headers.host||'localhost'}`)||parseRequestUrl(req);
  if(!url||!owned(url.pathname))return false;
  json(res,503,FEATURE_REFUSAL);return true;
}
function createFeatureRoutes({ json, readJson, decisionSettings = null }) {
  return async function featureRoutes(req, res, { path, authn }) {
    if (owned(path)) return json(res,503,FEATURE_REFUSAL),true;
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
    return false;
  };
}
module.exports = { createFeatureRoutes,refuseOwnedFeatures,FEATURE_REFUSAL };
