'use strict';
const PATH = '/api/model-manager/models';
const OWNED_ROUTES = Object.freeze(new Set(['GET '+PATH]));
const ROUTE_REFUSAL = Object.freeze({error:'The model folder scan read is owned by the Rust front.',code:'RUST_MODEL_MANAGER_SCAN_OWNED'});
function refuseOwned(req,res,{parseRequestUrl,json}) {
  if(req.method!=='GET'||parseRequestUrl(req)?.pathname!==PATH)return false;
  json(res,503,ROUTE_REFUSAL);return true;
}
module.exports={PATH,OWNED_ROUTES,ROUTE_REFUSAL,refuseOwned};
