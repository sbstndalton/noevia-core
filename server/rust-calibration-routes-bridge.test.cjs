'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), {EventEmitter} = require('node:events');
const {createCalibrationRoutesBridge} = require('./rust-calibration-routes-bridge.cjs');
const {createCalibrator} = require('./llamacpp-calibration.cjs');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
function fixture({hold, stateFile, conservativeFor}={}) {
  let revision='r1', artifact='artifact-A', row={id:'synthetic',meta:{n_ctx_train:32768},status:{value:'unloaded'}};
  const seen={holds:0,releases:0,requests:0,reads:0};
  const actor=createCalibrator({stateFile,rawModels:async()=>{seen.reads++;return {ok:true,body:{data:[row]}};},
    presets:{get:()=>({exists:true,options:{},fields:['parallel']}),snapshot:()=>({revision,text:'private'})},
    conservativeFor:conservativeFor||(async()=>null),identityFor:async()=>({artifact}),request:async()=>{seen.requests++;throw Error('no worker calls allowed');},
    maintenance:{hold:async()=>{seen.holds++;await hold?.();return()=>{seen.releases++;};}},readMemory:()=>20});
  return {actor,seen,rev:v=>{revision=v;},row:v=>{row=v;},artifact:v=>{artifact=v;}};
}
async function command(actor) {
  const {token}=actor.stateFacts(),model='synthetic';
  const {rowToken}=await actor.listingFacts(model,token);
  const {preparedToken}=await actor.preparationFacts(model,token,rowToken);
  return {model,token,rowToken,preparedToken,plan:{promptBudgetSeconds:60,native:32768,base:{}}};
}
test('public start/status are retired; state facts exclude original profile text',()=>{
  const {actor}=fixture();assert.equal(actor.start,undefined);assert.equal(actor.status,undefined);
  actor._state().job={id:'j',model:'synthetic',status:'failed',originalText:'private'};
  assert.equal(actor.stateFacts().job.originalText,undefined);
});
test('a changed profile before admission causes zero holds and zero worker requests',async()=>{
  const f=fixture(),ask=await command(f.actor);f.rev('r2');
  assert.deepEqual(await f.actor.compareAndLaunch(ask),{applied:false,reason:'stale'});
  assert.equal(f.seen.holds,0);assert.equal(f.seen.requests,0);assert.equal(f.actor.stateFacts().job,null);
});
test('changed profile or model identity during hold releases it without launching',async()=>{
  for(const change of ['profile','identity','artifact']) {
    let f;f=fixture({hold:async()=>{if(change==='profile')f.rev('r2');else if(change==='artifact')f.artifact('artifact-B');else f.row({id:'synthetic',meta:{n_ctx_train:65536},status:{value:'unloaded'}});}});
    const ask=await command(f.actor);assert.deepEqual(await f.actor.compareAndLaunch(ask),{applied:false,reason:'stale'});
    assert.equal(f.seen.holds,1);assert.equal(f.seen.releases,1);assert.equal(f.seen.requests,0);assert.equal(f.actor.stateFacts().job,null);
  }
});
test('disconnect while admission awaits releases its hold and never launches',async()=>{
  const controller=new AbortController(),f=fixture({hold:async()=>controller.abort()}),ask=await command(f.actor);
  assert.equal((await f.actor.compareAndLaunch(ask,{signal:controller.signal})).applied,false);
  assert.equal(f.seen.releases,1);assert.equal(f.seen.requests,0);
});
test('one pending launch owns admission; a second command cannot join its hold',async()=>{
  let releaseHold,held;const entered=new Promise(r=>{held=r;}),wait=new Promise(r=>{releaseHold=r;});
  const f=fixture({hold:async()=>{held();await wait;}}),ask=await command(f.actor);
  const first=f.actor.compareAndLaunch(ask);await entered;
  assert.equal(f.actor.stateFacts().starting,true);assert.equal((await f.actor.compareAndLaunch(ask)).applied,false);
  f.rev('r2');releaseHold();assert.equal((await first).applied,false);assert.equal(f.seen.holds,1);assert.equal(f.seen.releases,1);assert.equal(f.seen.requests,0);
});
test('failed initial state write releases admission and restores the previous in-memory job',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'calibration-prepare-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const f=fixture({stateFile:path.join(dir,'absent','state.json')}),ask=await command(f.actor);
  await assert.rejects(f.actor.compareAndLaunch(ask),{code:'ENOENT'});assert.equal(f.actor.stateFacts().job,null);assert.equal(f.seen.releases,1);assert.equal(f.seen.requests,0);
});
async function bridgeCase({op='facts',ask={},peer='127.0.0.1',headers={},method='POST',live}={}) {
  const req=Object.assign(new EventEmitter(),{method,url:'/internal/calibration-routes/'+op,headers:{'x-noevia-store-token':'synthetic-secret',...headers},socket:{remoteAddress:peer}}),res=Object.assign(new EventEmitter(),{writableEnded:false});
  let answer;
  const bridge=createCalibrationRoutesBridge({secret:'synthetic-secret',readJson:async()=>ask,json:(_r,status,body)=>{answer={status,body};res.writableEnded=true;},calibration:()=>live,log:()=>{}});
  assert.equal(await bridge(req,res),true);return answer;
}
test('bridge requires loopback, captured token and absence of even empty forwarded headers',async()=>{
  for(const input of [{peer:'192.0.2.10'},{headers:{'x-noevia-store-token':'wrong'}},{headers:{'x-forwarded-for':''}},{headers:{'x-noevia-client-ip':''}},{method:'GET'}])assert.equal((await bridgeCase(input)).status,404);
});
test('bridge is closed schema and fixed generic fault, never a whole-handler proxy',async()=>{
  assert.equal((await bridgeCase({ask:{model:'extra'}})).status,400);
  assert.deepEqual(await bridgeCase(),{status:200,body:{available:false}});
  const live={stateFacts(){throw Object.assign(Error('private engine detail'),{code:'private'});},listingFacts(){},preparationFacts(){},compareAndLaunch(){}};
  assert.deepEqual(await bridgeCase({live}),{status:503,body:{error:'Calibration state is unavailable.'}});
});
