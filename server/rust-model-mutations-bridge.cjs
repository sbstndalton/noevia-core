'use strict';
// Shared Node gate/cache/workspace authorities only. No engine call or deletion executor.
// J/H can replace the activity client without changing native route policy.
const { trustedFront } = require('./trusted-front.cjs');
const PREFIX = '/internal/model-mutations/';
const MAX = 4096;
function createModelMutationsBridge({ secret, json, readJson, manager, service, asUser, env, setTimer=setTimeout, clearTimer=clearTimeout }) {
  const tickets = new Map();
  function expire(id) {
    const old=tickets.get(id); if(old){clearTimer(old.timer);old.leave?.();}
    // Leave-before-enter is remembered: a cancelled acquire cannot arrive later and leak.
    const row={leave:null,timer:null};
    row.timer=setTimer(()=>{if(tickets.get(id)===row)tickets.delete(id);},660000);row.timer?.unref?.();tickets.set(id,row);
  }
  function cover(id,row,ms){clearTimer(row.timer);row.timer=setTimer(()=>expire(id),ms+10000);row.timer?.unref?.();}
  return async function handle(req,res) {
    const path=String(req.url||'').split('?')[0]; if(!path.startsWith(PREFIX))return false;
    if(req.method!=='POST'||!trustedFront(req,secret)||Object.hasOwn(req.headers,'x-forwarded-for')||Object.hasOwn(req.headers,'x-noevia-client-ip')){json(res,404,{error:'Not found'});return true;}
    let ask;try{ask=await readJson(req,16384);}catch{json(res,400,{error:'invalid JSON'});return true;}
    const op=path.slice(PREFIX.length);
    if(!ask||typeof ask!=='object'||Array.isArray(ask)){json(res,400,{error:'Invalid activity request'});return true;}
    try {
      if(['enter','touch','leave'].includes(op)){
        const {ticket,withinMs=120000}=ask;
        if(typeof ticket!=='string'||!/^[a-f0-9]{64}$/.test(ticket)||!Number.isInteger(withinMs)||withinMs<1||withinMs>600000){json(res,400,{error:'Invalid activity request'});return true;}
        if(op==='leave'){if(!tickets.has(ticket)&&tickets.size>=MAX){json(res,503,{error:'Model activity unavailable'});return true;}expire(ticket);json(res,200,{ok:true});return true;}
        let row=tickets.get(ticket);
        if(op==='enter'&&!row){
          if(tickets.size>=MAX)throw Error();
          const live=manager(); if(typeof live.enterInference!=='function')throw Error();
          const leave=live.enterInference();row={leave,timer:null};tickets.set(ticket,row);
        }
        if(!row?.leave){json(res,503,{error:'Model activity registration ended'});return true;}
        cover(ticket,row,withinMs);json(res,200,{ok:true});return true;
      }
      if(op==='protection'){
        const lib=require('./model-system.cjs'), embed=require('./embedding-service.cjs').current();
        json(res,200,{sidecarNames:[...lib.sidecarModelNames(env)],rerankerNames:[...lib.rerankModelNames(env)],protectionUnknown:!!env.MODEL_LOADER_URL&&!!embed?.protectionKnown&&!embed.protectionKnown()});return true;
      }
      if(op==='download'){
        if(!['requested','rejected'].includes(ask.state)||!Object.hasOwn(ask,'checkpoint'))throw Error();
        manager().noteDownload(ask.checkpoint,ask.state);json(res,200,{ok:true});return true;
      }
      if(op==='invalidate'){service.modelScanCache.clear();service.invalidateModelReads?.();json(res,200,{ok:true});return true;}
      if(op==='commit'){
        if(typeof ask.userId!=='string'||typeof ask.name!=='string')throw Error();
        const rolesCleared=await asUser(ask.userId,()=>{
          const roles=service.clearRoleReferences(ask.name);
          if(service.lastLoadedModel()===ask.name)service.clearLastLoadedModel(ask.name);
          manager().forgetIdentity?.(ask.name);service.modelScanCache.clear();service.invalidateModelReads?.();return roles;
        });json(res,200,{rolesCleared});return true;
      }
      json(res,404,{error:'Not found'});
    } catch(e){json(res,e?.status===503?503:503,{error:e?.status===503?e.message:'Model activity unavailable'});}
    return true;
  };
}
module.exports={createModelMutationsBridge,PREFIX};
