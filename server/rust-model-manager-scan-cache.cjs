'use strict';
const {trustedFront}=require('./trusted-front.cjs');
const PREFIX='/internal/model-manager-scan/';
const MAX_BYTES=16*1024*1024+4096;
const MAX_JSON=8*1024*1024;
// `clear` (sbstndalton/noevia#2550): the front's native auto-tune start and resume commit clear the scan, as this
// process's /api/models/* writes and its resume bridge do (modelScanCache.clear: a new generation, nothing cached).
function createModelManagerScanCache({secret,json,readJson,service,log=message=>console.warn(message)}) {
  return async function handle(req,res) {
    const path=String(req.url||'').split('?')[0],op=path.slice(PREFIX.length);
    if(!path.startsWith(PREFIX)||!['snapshot','publish','refresh','clear'].includes(op))return false;
    if(req.method!=='POST'||!trustedFront(req,secret)||Object.hasOwn(req.headers,'x-forwarded-for')||Object.hasOwn(req.headers,'x-noevia-client-ip')){json(res,404,{error:'Not found'});return true;}
    let ask;try{ask=await readJson(req,MAX_BYTES);}catch{json(res,400,{error:'invalid JSON'});return true;}
    const keys=op==='snapshot'||op==='clear'?[]:op==='publish'?['token','bodyJson']:['token'];
    if(!ask||typeof ask!=='object'||Array.isArray(ask)||Object.keys(ask).length!==keys.length||Object.keys(ask).some(k=>!keys.includes(k))
      ||op!=='snapshot'&&op!=='clear'&&(typeof ask.token!=='string'||!/^[0-9a-f]{64}$/.test(ask.token))
      ||op==='publish'&&(typeof ask.bodyJson!=='string'||Buffer.byteLength(ask.bodyJson)>MAX_JSON)){json(res,400,{error:'Invalid scan cache operation.'});return true;}
    try {
      let body;
      if(op==='publish'){body=JSON.parse(ask.bodyJson);if(!body||typeof body!=='object')throw Error('invalid cache data');}
      const answer=op==='clear'?(service.modelScanCache.clear(),{cleared:true}):op==='snapshot'?service.modelScanSnapshot():op==='publish'?service.publishModelScan(body,ask.token):service.requestModelScanRefresh(ask.token);
      if(Buffer.byteLength(JSON.stringify(answer))>MAX_JSON+4096)throw Error('cache over cap');
      json(res,200,answer);
    }catch{log('[model-manager-scan] cache operation failed');json(res,503,{error:'Model scan cache is unavailable.'});}
    return true;
  };
}
module.exports={createModelManagerScanCache,PREFIX,MAX_BYTES};
