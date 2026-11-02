'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createFullAutotuner } = require('./llamacpp-full-autotune.cjs');
const { createAutotuneSettingsBridge, PREFIX } = require('./rust-autotune-settings-bridge.cjs');
const refusal = require('./rust-autotune-settings.cjs');
const secret = 'synthetic-front-token';
function fixture(t, state = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'autotune-settings-state-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file = path.join(dir,'tune.json'); fs.writeFileSync(file, JSON.stringify({history:{synthetic:[{id:'past'}]},settings:{other:{allowQ5Kv:true}},...state}));
  let revision = 'config-1';
  const presets = {get: model => ({exists:['synthetic','other','__proto__'].includes(model),revision})};
  const make = () => createFullAutotuner({stateFile:file,presets,request:()=>assert.fail('no engine request'),rawModels:()=>assert.fail('no model listing'),maintenance:{},applyUnlocked:()=>assert.fail('no preset write'),identityFor:()=>assert.fail('no identity probe'),contextFactory:()=>assert.fail('no calibration'),loadAdvisor:{},planner:{},longProfiles:{},servingChecks:{}});
  const tuner=make(), sent=[];
  const bridge=createAutotuneSettingsBridge({secret,tuner:()=>tuner,json:(_res,status,body)=>sent.push({status,body}),readJson:async req=>req.body,log:()=>{}});
  const req=(target,body={},over={})=>({url:PREFIX+target,method:'POST',socket:{remoteAddress:'127.0.0.1'},headers:{'x-noevia-store-token':secret},body,...over});
  return {tuner,file,make,sent,bridge,req,revision:v=>{revision=v},read:()=>JSON.parse(fs.readFileSync(file,'utf8'))};
}
test('conditional mutation preserves job/history/other settings and persists only an own map entry', t=>{
  const job={id:'job',status:'passed',models:[{model:'synthetic',status:'passed'}],_private:'never-expose',beforeText:'never-expose',nested:{_secret:'never-expose',ok:1}};
  const f=fixture(t,{job}); const before=f.tuner.settingsFacts('synthetic');
  const changed=f.tuner.commitSettings('synthetic',true,before.token);
  assert.equal(changed.applied,true); assert.equal(changed.facts.guard.allowQ5Kv,true);
  assert.deepEqual(f.read().job,job); assert.deepEqual(f.read().history,{synthetic:[{id:'past'}]}); assert.deepEqual(f.read().settings.other,{allowQ5Kv:true});
  assert.ok(!JSON.stringify(changed.facts).includes('never-expose'));
  assert.equal(f.make().settingsFacts('synthetic').guard.allowQ5Kv,true,'new actor reads persisted settings');
  const proto=f.tuner.settingsFacts('__proto__'); assert.equal(f.tuner.commitSettings('__proto__',true,proto.token).applied,true);
  assert.ok(Object.hasOwn(f.read().settings,'__proto__')); assert.equal(f.make().settingsFacts('__proto__').guard.allowQ5Kv,true);
});
test('stale generations/configuration reject without overwriting later actor changes', t=>{
  const f=fixture(t); const initial=f.tuner.settingsFacts('synthetic');
  const other=f.tuner.settingsFacts('other'); assert.equal(f.tuner.commitSettings('other',false,other.token).applied,true);
  const before=fs.readFileSync(f.file,'utf8'); assert.deepEqual(f.tuner.commitSettings('synthetic',true,initial.token),{applied:false}); assert.equal(fs.readFileSync(f.file,'utf8'),before);
  const fresh=f.tuner.settingsFacts('synthetic'); f.revision('config-2'); assert.deepEqual(f.tuner.commitSettings('synthetic',true,fresh.token),{applied:false});
  const restarted=f.make(); assert.deepEqual(restarted.commitSettings('synthetic',true,f.tuner.settingsFacts('synthetic').token),{applied:false},'process generation is bound');
});
test('a pending-job mutation invalidates the exact snapshot without a tune or model call', t=>{
  const f=fixture(t,{job:{id:'pending',status:'cancelled',models:[{model:'synthetic',status:'pending'}]}});
  const snapshot=f.tuner.settingsFacts('synthetic');
  assert.equal(f.tuner.clear().status,200);
  const after=fs.readFileSync(f.file,'utf8');
  assert.deepEqual(f.tuner.commitSettings('synthetic',true,snapshot.token),{applied:false});
  assert.equal(fs.readFileSync(f.file,'utf8'),after);
  assert.deepEqual(f.read().history,{synthetic:[{id:'past'}]});
});
test('a persistence failure rolls back the in-memory setting', t=>{
  const f=fixture(t); const snapshot=f.tuner.settingsFacts('synthetic');
  fs.renameSync(f.file,f.file+'.old');fs.mkdirSync(f.file);
  assert.throws(()=>f.tuner.commitSettings('synthetic',true,snapshot.token));
  assert.equal(f.tuner.settingsFacts('synthetic').guard.allowQ5Kv,false);
});
test('trusted bridge sends facts and a synchronous primitive, never a public settings response', async t=>{
  const f=fixture(t); await f.bridge(f.req('facts'),{}); assert.deepEqual(f.sent.pop(),{status:200,body:{available:true,settingsAvailable:true}});
  await f.bridge(f.req('facts',{model:'synthetic'}),{}); const snap=f.sent.pop();assert.equal(snap.status,200);
  await f.bridge(f.req('commit',{model:'synthetic',allowQ5Kv:true,token:snap.body.facts.token}),{});
  const changed=f.sent.pop();assert.equal(changed.status,200);assert.equal(changed.body.applied,true);assert.equal(changed.body.settings,undefined);assert.equal(changed.body.kvCandidates,undefined);
});
test('bridge rejects forwarded peers/header presence, missing secrets and extra selectors',async t=>{
  const f=fixture(t);
  for(const over of [{method:'GET'},{socket:{remoteAddress:'10.0.0.1'}},{headers:{}},{headers:{'x-noevia-store-token':'wrong'}},{headers:{'x-noevia-store-token':secret,'x-forwarded-for':''}},{headers:{'x-noevia-store-token':secret,'x-noevia-client-ip':''}}]) {
    await f.bridge(f.req('facts',{},over),{});assert.equal(f.sent.pop().status,404);
  }
  for(const body of [null,[],{userId:'other'},{model:'x'.repeat(201)},{model:3}]) {await f.bridge(f.req('facts',body),{});assert.equal(f.sent.pop().status,400);}
});
test('every public method is refused by Core while sibling paths stay with their owners',()=>{
  for(const method of ['GET','POST','HEAD','PUT','DELETE','OPTIONS']) {
    let got;assert.equal(refusal.refuseOwned({method,url:'/api/models/autotune/settings?model=x'},{},{parseRequestUrl:r=>new URL(r.url,'http://localhost'),json:(_r,status,body)=>{got={status,body}}}),true);
    assert.deepEqual(got,{status:503,body:refusal.ROUTE_REFUSAL});
  }
  assert.equal(refusal.refuseOwned({url:'/api/models/autotune'},{},{parseRequestUrl:r=>new URL(r.url,'http://localhost')}),false);
});
