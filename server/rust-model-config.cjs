'use strict';
// Configuration owners export raw state. Derived installed/protection facts belong to Rust.
const { trustedFront } = require('./trusted-front.cjs');
function configuration(env=process.env) {
      const embed=require('./embedding-service.cjs').current();
      const config=require('./embedding-config.cjs').current();
      const rerank=require('./rerank-settings.cjs').current();
      const raw={ env:Object.fromEntries(['EMBEDDING_MODEL','EMBED_MODEL','EMBEDDING_NEXT_MODEL','NOEVIA_FEATURE_RAG_RERANK','RERANK_MODEL'].map(k=>[k,env[k]??null])),
        embedding:embed?.managed()?{status:embed.status(),protected:[...embed.protectedNames()],baseUrl:embed.baseUrl}:null,
        config:config?{names:config.modelNames(),targets:[config.active(),config.next(),config.previous()].filter(Boolean)}:null,
        rerank:rerank?Object.fromEntries(['NOEVIA_FEATURE_RAG_RERANK','RERANK_MODEL'].map(k=>[k,rerank.effectiveEnv()[k]??null])):null };
      return {...raw,revision:require('node:crypto').createHash('sha256').update(JSON.stringify(raw)).digest('hex')};
}
function createBridge({ secret, json, readJson, env, service }) {
  return async (req, res) => {
    if (String(req.url || '').split('?')[0] !== '/internal/model-config') return false;
    if (req.method !== 'POST' || !trustedFront(req, secret) || Object.hasOwn(req.headers,'x-forwarded-for') || Object.hasOwn(req.headers,'x-noevia-client-ip')) { json(res,404,{error:'Not found'}); return true; }
    try {
      const body=await readJson(req,4096);
      if (body?.firstLoaded && typeof body.firstLoaded==='string') service.rememberFirstLoaded(body.firstLoaded);
      json(res,200,configuration(env));
    } catch { json(res,503,{error:'Model configuration unavailable.'}); }
    return true;
  };
}
module.exports={createBridge,configuration};
