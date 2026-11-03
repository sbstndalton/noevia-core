'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createFullAutotuner}=require('./llamacpp-full-autotune.cjs');
const {createAutotuneReadBridge,PATH}=require('./rust-autotune-read-bridge.cjs');
const {refuseOwned}=require('./rust-autotune-read.cjs');
function fixture(t,state={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'noevia-autotune-read-')),file=path.join(dir,'state.json');
 fs.writeFileSync(file,JSON.stringify(state),{mode:0o600});t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const forbidden=()=>assert.fail('status must not access an engine, profile, worker or limiter');
 const actor=createFullAutotuner({stateFile:file,request:forbidden,rawModels:forbidden,presets:{snapshot:forbidden,get:forbidden},maintenance:{holdWhenIdle:forbidden},applyUnlocked:forbidden,identityFor:forbidden,contextFactory:forbidden,servingChecks:{},planner:{},loadAdvisor:{},longProfiles:{}});
 return{actor,file,bytes:()=>fs.readFileSync(file,'utf8')};
}
test('raw owner getter reads only explicit in-memory keys without computing a public response',t=>{
 const f=fixture(t,{job:{id:'j',model:'base',status:'running',models:[]},history:{base:[{at:1,context:8192}],chosen:[{at:2,context:16384}]},settings:{base:{allowQ5Kv:true}}});
 const before=f.bytes(),out=f.actor.statusFacts(['base','chosen']);
 assert.equal(out.entries[0].key,'base');assert.deepEqual(out.entries[0].history,[{at:1,context:8192}]);assert.equal(out.entries[0].allowQ5Kv,true);
 assert.equal(out.entries[1].key,'chosen');assert.equal(out.entries[1].allowQ5Kv,false);
 for(const key of ['status','body','history','longId','longHistory','settings','kvCandidates','modes'])assert.equal(Object.hasOwn(out,key),false,key);
 assert.equal(f.bytes(),before);assert.equal(f.actor.status,undefined);assert.equal(typeof f.actor.start,'function');
});
test('history is raw up to its owner data; the native composer owns the ten-entry bound',t=>{
 const history=Array.from({length:12},(_,at)=>({at,context:4096+at}));const f=fixture(t,{history:{m:history}});
 assert.equal(f.actor.statusFacts(['m']).entries[0].history.length,12);
});
test('owner projection excludes private profiles and malformed HTTP credential fields recursively',t=>{
 const f=fixture(t,{job:{id:'j',model:'m\ud800',status:'failed',originalText:'never-public',unknown:{secret:'never-public'},models:[{model:'m',phases:[{steps:[{value:{originalRevision:'never-public',Authorization:'never-public',access_token:'never-public',url:'https://u:p@host/path?token=never-public',answer:'visible'}}]}]}]},history:{m:[{at:1,unknown:{credentials:'never-public'},sampling:{values:{api_key:'never-public',temp:0.7}},quality:{checks:[{originalText:'never-public',answer:'visible'}]}}]},settings:{m:{allowQ5Kv:{token:'never-public'}}}});
 const out=f.actor.statusFacts(['m']);assert.equal(out.job.model,'m\ud800');assert.equal(out.entries[0].allowQ5Kv,false);assert.ok(!JSON.stringify(out).includes('never-public'));assert.ok(JSON.stringify(out).includes('visible'));
});
test('missing and explicit null jobs differ, and prototype model names use only own entries',t=>{
 const empty=fixture(t),nil=fixture(t,{job:null});assert.equal(empty.actor.statusFacts().jobPresent,false);assert.equal(nil.actor.statusFacts().jobPresent,true);assert.equal(nil.actor.statusFacts().job,null);
 const f=fixture(t,JSON.parse('{"history":{"__proto__":[{"at":3,"context":8192}]},"settings":{"__proto__":{"allowQ5Kv":true}}}'));
 const out=f.actor.statusFacts(['__proto__','constructor']);assert.deepEqual(out.entries[0].history,[{at:3,context:8192}]);assert.equal(out.entries[0].allowQ5Kv,true);assert.equal(out.entries[1].history,null);assert.equal(out.entries[1].allowQ5Kv,false);
});
test('malformed data and unbounded or coercing selectors are refused without writes',t=>{
 const f=fixture(t,{history:{m:{headers:{Authorization:'never-public'}}}}),before=f.bytes();
 for(const ask of [null,{},[{}],['a','b','c'],['x'.repeat(65537)]])assert.throws(()=>f.actor.statusFacts(ask));
 assert.throws(()=>f.actor.statusFacts(['m']));assert.equal(f.bytes(),before);
});
const request=(over={})=>({url:PATH,method:'POST',socket:{remoteAddress:'127.0.0.1'},headers:{'x-noevia-store-token':'synthetic'},...over});
test('facts bridge rejects public, forwarded and malformed requests before owner access',async()=>{
 const sent=[];let ask={keys:[]};
 const handle=createAutotuneReadBridge({secret:'synthetic',json:(_r,status,body)=>sent.push({status,body}),readJson:async()=>ask,autotune:()=>assert.fail('no owner access')});
 for(const r of [request({method:'GET'}),request({socket:{remoteAddress:'10.0.0.2'}}),request({headers:{}}),request({headers:{'x-noevia-store-token':'bad'}}),request({headers:{'x-noevia-store-token':'synthetic','x-forwarded-for':''}}),request({headers:{'x-noevia-store-token':'synthetic','x-noevia-client-ip':''}})]){await handle(r,{});assert.equal(sent.pop().status,404);}
 for(ask of [null,[],{}, {keys:[{}]}, {keys:['a','b','c']},{keys:[],model:'unexpected'}]){await handle(request(),{});assert.equal(sent.pop().status,400);}
});
test('bridge returns bounded raw facts with fixed failures and no credential payload',async t=>{
 const f=fixture(t,{history:{m:[{at:1,context:8192}]}}),sent=[];let live=f.actor;
 const handle=createAutotuneReadBridge({secret:'synthetic',json:(_r,status,body)=>sent.push({status,body}),readJson:async()=>({keys:['m']}),autotune:()=>live,log:()=>{}});
 await handle(request(),{});assert.equal(sent.at(-1).status,200);assert.equal(sent.at(-1).body.available,true);assert.equal(sent.at(-1).body.entries[0].key,'m');
 live=null;await handle(request(),{});assert.deepEqual(sent.pop(),{status:200,body:{available:false}});
 for(live of [{},{statusFacts(){throw Error('never-public');}},{statusFacts:()=>({data:'x'.repeat(8*1024*1024)})}]){await handle(request(),{});assert.equal(sent.at(-1).status,503);assert.ok(!JSON.stringify(sent.at(-1)).includes('never-public'));}
});
test('direct Node refuses GET only; POST start and all other methods keep Node ownership',()=>{
 const parseRequestUrl=req=>new URL(req.url,'http://synthetic');let status;
 assert.equal(refuseOwned({method:'GET',url:'/api/models/autotune?model=m'},{},{parseRequestUrl,json:(_r,s)=>{status=s;}}),true);assert.equal(status,503);
 for(const method of ['POST','HEAD','PUT','PATCH','DELETE','OPTIONS'])assert.equal(refuseOwned({method,url:'/api/models/autotune'},{},{parseRequestUrl,json:()=>assert.fail('method stolen')}),false);
 for(const url of ['/api/models/autotune/','/api/models/autotune/resume','/api/models/autotune-other'])assert.equal(refuseOwned({method:'GET',url},{},{parseRequestUrl,json:()=>assert.fail('neighbor')}),false);
});
