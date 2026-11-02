'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createFullAutotuner } = require('./llamacpp-full-autotune.cjs');
const { createAutotuneResumeBridge, PREFIX } = require('./rust-autotune-resume-bridge.cjs');
const { refuseOwned } = require('./rust-autotune-resume.cjs');
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise,resolve,reject }; };
function fixture(t, over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-resume-2301-')), file = path.join(dir, 'state.json');
  const job = { id:'j',model:'synthetic',status:'cancelled',_revision:'r1',_unsafe:false,originalText:'private-profile',unknown:'private-outer',
    models:[{model:'synthetic',status:'interrupted',originalText:'private-item',phases:[{id:'context',status:'interrupted',restored:true,steps:[{status:'passed'},{status:'pending'}]}]}],...over.job };
  fs.writeFileSync(file,JSON.stringify({job,history:{kept:[]},settings:{}}),{mode:0o600});
  let revision='r1', reads=0, reloads=0, workers=0;
  const holds=[];
  const actor=createFullAutotuner({stateFile:file,now:over.now||Date.now,
    presets:{snapshot:()=>({revision,text:'private-config'}),get:()=>({exists:true})},
    request:async target=>{assert.equal(target,'/models?reload=1');reloads++;return over.reload?over.reload():{ok:true};},
    rawModels:async()=>{reads++;return over.rows?over.rows():{ok:true,body:{data:[{id:'synthetic'}]}};},
    identityFor:async()=>over.identity?over.identity():({arch:'synthetic',quant:'Q8_0',artifact:'owned-artifact',build:null,profile:'f'.repeat(64),hardware:'synthetic'}),
    maintenance:{holdWhenIdle(){workers++;const d=deferred();holds.push(d);return d.promise;}},
    applyUnlocked:()=>assert.fail('no profile writes'),contextFactory:()=>assert.fail('no calibration'),
    servingChecks:{},planner:{},loadAdvisor:{},longProfiles:{},
  });
  t.after(async()=>{for(const h of holds)h.reject(Object.assign(Error('synthetic stop'),{cancelled:true}));await actor.completion().catch(()=>{});fs.rmSync(dir,{recursive:true,force:true});});
  return {actor,file,job,revision:r=>{revision=r;},counts:()=>({reads,reloads,workers}),read:()=>fs.readFileSync(file,'utf8')};
}
test('resume facts contain only selected metadata and exact process/job/config snapshots',t=>{
 const f=fixture(t),facts=f.actor.resumeFacts();
 assert.match(facts.token,/^[0-9a-f]{64}$/);assert.match(facts.generation,/^[0-9a-f]{64}$/);
 assert.ok(!JSON.stringify(facts).includes('private-'));assert.deepEqual(f.counts(),{reads:0,reloads:0,workers:0});
 f.revision('external');assert.notEqual(f.actor.resumeFacts().token,facts.token);
 assert.deepEqual(f.actor.compareAndResume(facts.token,{kind:'launch',reset:[]}),{applied:false});
 assert.equal(f.counts().workers,0);
});
test('listing preparation owns existing starting before its await and prevents competing job replacement',async t=>{
 const d=deferred(),f=fixture(t,{rows:()=>d.promise}),old=f.actor.resumeFacts();
 const preparing=f.actor.prepareResume(old.token,{stage:'listing'});
 assert.equal(f.actor.resumeFacts().starting,true);
 assert.equal((await f.actor.start('synthetic',{confirmPause:true})).status,409);
 assert.equal(f.actor.compareAndClear(f.actor.clearFacts().token).applied,false);
 const after=f.read();d.resolve({ok:true,body:{data:[{id:'synthetic'}]}});
 assert.equal((await preparing).applied,true);assert.equal(f.actor.resumeFacts().starting,false);
 assert.equal(f.read(),after);assert.equal(f.counts().workers,0);
});
test('configuration changes and another actor writer across metadata awaits invalidate preparation',async t=>{
 for(const change of ['revision','settings']){
  const d=deferred(),f=fixture(t,{rows:()=>d.promise});
  const preparing=f.actor.prepareResume(f.actor.resumeFacts().token,{stage:'listing'});
  if(change==='revision')f.revision('external');else{const facts=f.actor.settingsFacts('synthetic');assert.equal(f.actor.commitSettings('synthetic',true,facts.token).applied,true);}
  const after=f.read();d.resolve({ok:true,body:{data:[{id:'synthetic'}]}});
  assert.deepEqual(await preparing,{applied:false});assert.equal(f.read(),after);assert.equal(f.actor.resumeFacts().starting,false);
 }
});
test('reload reply cannot write through a stale job and cancellation fences a late reply',async t=>{
 for(const abort of [false,true]){
  const d=deferred(),f=fixture(t,{job:{_reloadPending:true,_pendingRevision:'r1'},reload:()=>d.promise}),controller=new AbortController();
  const preparing=f.actor.prepareResume(f.actor.resumeFacts().token,{stage:'identities',selectors:[]},controller.signal);
  if(abort)controller.abort();else await f.actor.recover();
  const after=f.read();d.resolve({ok:true});
  assert.deepEqual(await preparing,{applied:false});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.read(),after);assert.equal(f.actor.resumeFacts().starting,false);assert.equal(f.counts().workers,0);
 }
});
test('successful own reload accepts exactly its one-note transition and returns a released-state token',async t=>{
 const f=fixture(t,{job:{_reloadPending:true}});
 const before=f.actor.resumeFacts(),out=await f.actor.prepareResume(before.token,{stage:'identities',selectors:[{index:0,field:'model'}]});
 assert.equal(out.applied,true);assert.equal(out.starting,false);assert.equal(out.token,f.actor.resumeFacts().token);
 assert.equal(out.generation,before.generation);assert.match(out.identities[0].identity,/^[0-9a-f]{64}$/);
 const state=JSON.parse(f.read());assert.equal(state.job._reloadPending,false);assert.equal(state.job.log.length,1);
 assert.ok(!JSON.stringify(out).includes('private-'));assert.equal(f.counts().workers,0);
});
test('failed synchronous save rolls back the exact job without starting a worker or losing identity',t=>{
 const f=fixture(t),before=f.actor.resumeFacts(),bytes=f.read(),rename=fs.renameSync;
 fs.renameSync=(src,dest)=>{if(dest===f.file)throw Error('synthetic save failure');return rename(src,dest);};
 try{assert.throws(()=>f.actor.compareAndResume(before.token,{kind:'filter',keep:[],skipped:[{index:0,reason:'System routing model — not tuned'}],complete:true,model:null}),/synthetic save failure/);}finally{fs.renameSync=rename;}
 assert.equal(f.read(),bytes);assert.deepEqual(f.actor.resumeFacts(),before);assert.equal(f.counts().workers,0);
});
test('conditional indexed launch starts only the selected current run and consumes the old snapshot',async t=>{
 const f=fixture(t),before=f.actor.resumeFacts();
 const out=f.actor.compareAndResume(before.token,{kind:'launch',reset:[{index:0,phases:[{index:0,keepSteps:[0]}]}]});
 assert.equal(out.applied,true);assert.equal(f.counts().workers,1);assert.notEqual(out.generation,before.generation);
 assert.ok(!JSON.stringify(out).includes('private-'));assert.deepEqual(f.actor.compareAndResume(before.token,{kind:'launch',reset:[]}),{applied:false});
 assert.deepEqual(out.publicJob.models[0].phases[0].steps,[{status:'passed'}]);
});
test('malformed patches cannot write or start work',t=>{
 const f=fixture(t),before=f.actor.resumeFacts(),bytes=f.read();
 for(const plan of [null,{}, {kind:'launch',reset:[{index:99,phases:[]}]},{kind:'filter',keep:[0,0],skipped:[],complete:false,model:null}])assert.throws(()=>f.actor.compareAndResume(before.token,plan));
 assert.equal(f.read(),bytes);assert.equal(f.counts().workers,0);
});
test('bridge rejects public/forwarded/wrong-secret requests before reading the actor',async()=>{
 const sent=[],handle=createAutotuneResumeBridge({secret:'s',json:(_r,status,body)=>sent.push({status,body}),readJson:async()=>({}),autotune:()=>assert.fail('no actor access')});
 for(const headers of [{},{'x-noevia-store-token':'bad'},{'x-noevia-store-token':'s','x-forwarded-for':''},{'x-noevia-store-token':'s','x-noevia-client-ip':''}]){
  await handle({url:PREFIX+'facts',method:'POST',socket:{remoteAddress:'127.0.0.1'},headers},{});assert.equal(sent.pop().status,404);
 }
});
test('all exact public methods refuse in Node and neighbors remain separate',()=>{
 const parseRequestUrl=req=>new URL(req.url,'http://synthetic');
 for(const method of ['GET','HEAD','POST','PUT','DELETE','OPTIONS']){
  let status;assert.equal(refuseOwned({url:'/api/models/autotune/resume',method},{},{parseRequestUrl,json:(_r,s)=>{status=s;}}),true);assert.equal(status,503);
 }
 assert.equal(refuseOwned({url:'/api/models/autotune/resume/'},{},{parseRequestUrl,json:()=>assert.fail('neighbor')}),false);
});


test('malformed secret-bearing flag/identity payloads never become bridge facts',t=>{
 const f=fixture(t,{job:{_unsafe:{authorization:'private-unsafe'},models:[{model:'synthetic',status:'cancelled',_identity:{headers:{Authorization:'private-identity'}},sectionCreated:{secret:'private-section'},phases:[{id:'context',status:'interrupted',restored:{token:'private-restored'},steps:[{status:{secret:'private-step'}}]}]}]}});
 const facts=f.actor.resumeFacts();assert.equal(facts.job.unsafe,true);assert.equal(facts.job.models[0].identitySet,true);assert.equal(facts.job.models[0].identity,null);
 assert.ok(!JSON.stringify(facts).includes('private-'));assert.deepEqual(f.counts(),{reads:0,reloads:0,workers:0});
});


test('successful conditional writes invalidate the existing model scan, stale/facts/denied calls do not',async t=>{
 const f=fixture(t),sent=[];let invalidations=0,ask={};
 const handle=createAutotuneResumeBridge({secret:'s',json:(_r,status,body)=>sent.push({status,body}),readJson:async()=>ask,autotune:()=>f.actor,invalidate:()=>{invalidations++;}});
 const req=action=>({url:PREFIX+action,method:'POST',socket:{remoteAddress:'127.0.0.1'},headers:{'x-noevia-store-token':'s'}});
 await handle(req('facts'),{});const token=sent.pop().body.token;assert.equal(invalidations,0);
 ask={token,plan:{kind:'filter',keep:[],skipped:[{index:0,reason:'System routing model — not tuned'}],complete:true,model:null}};
 await handle(req('commit'),{});assert.equal(sent.pop().status,200);assert.equal(invalidations,1);
 await handle(req('commit'),{});assert.equal(sent.pop().status,409);assert.equal(invalidations,1);
 await handle({...req('commit'),headers:{}},{});assert.equal(sent.pop().status,404);assert.equal(invalidations,1);assert.equal(f.counts().workers,0);
});


test('post-guard config or role changes are not adopted as an allowed own reload delta',async t=>{
 const roles=require('./model-system.cjs');
 try{
  for(const change of ['revision','role']){
   roles.rememberSectionRoles('');let f;
   f=fixture(t,{job:{_reloadPending:true},now:()=>{if(change==='revision')f.revision('outside-change');else roles.rememberSectionRoles(JSON.stringify({synthetic:'system-routing'}));return 1000;}});
   const out=await f.actor.prepareResume(f.actor.resumeFacts().token,{stage:'identities',selectors:[]});
   assert.deepEqual(out,{applied:false});assert.equal(f.actor.resumeFacts().starting,false);assert.equal(f.counts().workers,0);
  }
 }finally{roles.rememberSectionRoles('');}
});
