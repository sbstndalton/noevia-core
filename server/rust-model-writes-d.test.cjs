'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {refuseOwned}=require('./rust-idle-unload-read.cjs');
const {createModelWriteEffects,PATH}=require('./rust-model-write-effects.cjs');
test('exact public writers refuse bypasses, other methods and suffixes remain unchanged',()=>{
 for(const [method,path] of [['PUT','/api/models/idle-unload'],['POST','/api/models/prune-missing']]){
  let sent;assert.equal(refuseOwned({method}, {},{parseRequestUrl:()=>({pathname:path}),json:(_r,status,body)=>{sent={status,body};}}),true);assert.equal(sent.status,503);
  assert.equal(refuseOwned({method},{},{parseRequestUrl:()=>({pathname:path+'/'}),json:()=>assert.fail()}),false);
 }
 assert.equal(refuseOwned({method:'GET'},{},{parseRequestUrl:()=>({pathname:'/api/models/prune-missing'}),json:()=>assert.fail()}),false);
});
test('notifications reject untrusted, forwarded and malformed callers before side effects',async()=>{
 let reads=0,effects=0,sent;
 const handle=createModelWriteEffects({secret:'synthetic',asUser:(user,fn)=>{assert.equal(user,'synthetic-admin');return fn();},json:(_r,status,body)=>{sent={status,body};},readJson:async()=>{reads++;return {op:'removed',names:['gone'],user:'synthetic-admin'};},
 service:{clearRoleReferences:()=>effects++,lastLoadedModel:()=> 'gone',clearLastLoadedModel:()=>effects++,modelScanCache:{clear:()=>effects++},invalidateModelReads:()=>effects++},manager:{forgetIdentity:()=>effects++}});
 const req={url:PATH,method:'POST',headers:{'x-noevia-store-token':'synthetic'},socket:{remoteAddress:'127.0.0.1'}};
 for(const variant of [{...req,socket:{remoteAddress:'192.0.2.1'}},{...req,headers:{}},{...req,headers:{...req.headers,'x-forwarded-for':''}},{...req,headers:{...req.headers,'x-noevia-client-ip':''}}]){
  assert.equal(await handle(variant,{}),true);assert.equal(sent.status,404);
 }
 assert.equal(reads,0);assert.equal(effects,0);
 await handle(req,{});assert.equal(sent.status,200);assert.equal(effects,5);assert.equal(reads,1);
});

test('runtime keeps baseline facts and exposes no idle writer',async()=>{
 const {createIdleUnloadSetting}=require('./idle-unload-setting.cjs');
 const facts=createIdleUnloadSetting({presetsInRouter:async()=>'[*]\nsleep-idle-seconds = 900\n'});
 assert.equal(facts.save,undefined);assert.equal(await facts.effectiveSeconds(),900);
});
