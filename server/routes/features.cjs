'use strict';
// GET  /api/features                 -> { flags }            any signed-in user (booleans only)
// GET  /api/admin/features           -> { features }         admin
// PUT  /api/admin/features/:name     { enabled } -> feature  admin
// /api/admin/decision-settings and /test are the Rust front's (#2190, rust-decision-settings.cjs).
// Returns true when it handled the request. CSRF/origin checks run before routes are mounted.
const FEATURE_REFUSAL=Object.freeze({ error:'Feature settings are owned by the Rust front.',code:'RUST_FEATURES_OWNED' });
const owned=path=>path==='/api/features'||path==='/api/admin/features'||path.startsWith('/api/admin/features/');
function refuseOwnedFeatures(req,res,{parseRequestUrl,json}) {
  const url=parseRequestUrl(req,`http://${req.headers.host||'localhost'}`)||parseRequestUrl(req);
  if(!url||!owned(url.pathname))return false;
  json(res,503,FEATURE_REFUSAL);return true;
}
function createFeatureRoutes({ json }) {
  return async function featureRoutes(req, res, { path }) {
    if (owned(path)) return json(res,503,FEATURE_REFUSAL),true;
    return false;
  };
}
module.exports = { createFeatureRoutes,refuseOwnedFeatures,FEATURE_REFUSAL };
