'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createModelService}=require('./models.cjs');
const {createModelManagerScanCache}=require('./rust-model-manager-scan-cache.cjs');
function service(fetchJson=async()=>({ok:true,body:{models:[]}})){
 return createModelService({env:{MODEL_LOADER_URL:'http://synthetic-loader'},fetchJson,modelManager:{enabled:false},currentWorkspace:()=>({}),listWorkspaces:()=>[]});
}
test('old generation cannot publish after a model write; current generation updates the existing Map',()=>{
 const s=service(),old=s.modelScanSnapshot();s.modelScanCache.clear();assert.equal(s.publishModelScan({models:['old']},old.token).applied,false);
 const current=s.modelScanSnapshot();assert.equal(s.publishModelScan({models:['fresh']},current.token).applied,true);assert.deepEqual(s.modelScanCache.get('models').body,{models:['fresh']});
});
test('a fresh Node/cache instance cannot accept a previous generation-zero token',()=>{
 const old=service(),fresh=service();assert.notEqual(old.modelScanSnapshot().token,fresh.modelScanSnapshot().token);
 assert.equal(fresh.publishModelScan({models:['old-instance']},old.modelScanSnapshot().token).applied,false);assert.equal(fresh.modelScanCache.get('models'),undefined);
});
test('conditional refresh cannot retarget an entry replaced in the same generation',()=>{
 let reads=0;const s=service(async()=>{reads++;return{ok:true,body:{models:[]}};});s.modelScanCache.set('models',{at:1,body:{models:['old']}});const snap=s.modelScanSnapshot();
 s.modelScanCache.set('models',{at:1,body:{models:['replacement']}});assert.equal(s.requestModelScanRefresh(snap.entryToken).applied,false);assert.equal(reads,0);
});
test('background refresh uses the one existing in-flight owner and a write wins over its late answer',async()=>{
 let done,reads=0;const waiting=new Promise(r=>{done=r;}),s=service(async()=>{reads++;await waiting;return{ok:true,body:{models:['late']}};});
 const snap=s.modelScanSnapshot();assert.equal(s.requestModelScanRefresh(snap.entryToken).applied,true);assert.equal(s.requestModelScanRefresh(snap.entryToken).applied,true);assert.equal(reads,1);
 s.modelScanCache.clear();done();await new Promise(r=>setImmediate(r));assert.equal(s.modelScanCache.get('models'),undefined);
});
test('native publication is visible to actual installedFacts without a second folder scan',async()=>{
 let reads=0;const s=service(async()=>{reads++;throw Error('duplicate scan');});const body={models:[{modelId:'synthetic',sections:['synthetic'],bytes:42,shape:{native:8192}}]};
 s.publishModelScan(body,s.modelScanSnapshot().token);const f=await s.installedFacts({ids:[],scan:true});assert.deepEqual(f.scan,body.models);assert.equal(reads,0);
});
async function bridge({op='snapshot',ask={},peer='127.0.0.1',headers={},s=service()}={}){
 let result;const handle=createModelManagerScanCache({secret:'synthetic-secret',service:s,readJson:async()=>ask,json:(_r,status,body)=>{result={status,body};},log:()=>{}});
 assert.equal(await handle({method:'POST',url:'/internal/model-manager-scan/'+op,headers:{'x-noevia-store-token':'synthetic-secret',...headers},socket:{remoteAddress:peer}},{}),true);return result;
}
test('bridge rejects wrong peer/token and even empty forwarded/client-IP headers',async()=>{
 for(const input of [{peer:'192.0.2.1'},{headers:{'x-noevia-store-token':'wrong'}},{headers:{'x-forwarded-for':''}},{headers:{'x-noevia-client-ip':''}}])assert.equal((await bridge(input)).status,404);
});
test('publication payload preserves lone surrogates as data, not a command selector',async()=>{
 const s=service(),token=s.modelScanSnapshot().token;assert.equal((await bridge({op:'publish',ask:{token,bodyJson:'{"models":["m\\ud800"]}'},s})).body.applied,true);
 assert.equal(s.modelScanCache.get('models').body.models[0],'m\ud800');assert.equal((await bridge({ask:{url:'http://other'}})).status,400);
});
test('public refusal owns only exact GET, leaving HEAD, other methods and prefix paths alone',()=>{
 const {refuseOwned}=require('./rust-model-manager-scan.cjs');let sent;
 const deps={parseRequestUrl:req=>new URL(req.url,'http://synthetic'),json:(_r,status,body)=>{sent={status,body};}};
 assert.equal(refuseOwned({method:'GET',url:'/api/model-manager/models?refresh=1'}, {},deps),true);assert.equal(sent.status,503);
 for(const [method,url] of [['HEAD','/api/model-manager/models'],['POST','/api/model-manager/models'],['GET','/api/model-manager/models/'],['GET','/api/model-manager/models/delete']])assert.equal(refuseOwned({method,url},{},deps),false);
});
