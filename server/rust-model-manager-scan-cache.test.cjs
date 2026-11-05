"use strict";
const test=require('node:test'),assert=require('node:assert/strict');
const {createModelService}=require('./models.cjs');
const {createModelRoutes}=require('./routes/models.cjs');
const {createClient}=require('./project-store-client.cjs');
test('Node delegates scan reads and invalidation without cache publication or refresh',async()=>{
 let reads=0,clears=0;
 const native={scanRead:async()=>{reads++;return {models:['synthetic']};},scanInvalidate:async()=>{clears++;}};
 const s=createModelService({fetchJson:()=>{throw Error('duplicate scan')},env:{MODEL_LOADER_URL:'http://synthetic'},modelManager:{},currentWorkspace:()=>({}),scanAuthority:native});
 assert.deepEqual(await s.modelScanCache.get('models'),{body:{models:['synthetic']}});
 await s.modelScanCache.clear();assert.equal(reads,1);assert.equal(clears,1);
 for(const name of ['publishModelScan','requestModelScanRefresh','refreshModelScan','modelScanSnapshot'])assert.equal(s[name],undefined);
 assert.equal(s.modelScanCache.set,undefined);
});
test('private client fixes scan endpoints and refuses failed invalidation',async()=>{
 const seen=[];let status=200;
 const client=createClient({port:1234,token:'synthetic-secret',fetchImpl:async(url,init)=>{seen.push([url,JSON.parse(init.body)]);return new Response(JSON.stringify(url.endsWith('invalidate')?{ok:true}:{models:['synthetic']}),{status});}});
 assert.deepEqual(await client.modelScanRead(),{models:['synthetic']});await client.modelScanInvalidate();
 assert.deepEqual(seen.map(x=>x[0].split('/v1/')[1]),['model-scan/read','model-scan/invalidate']);
 assert.deepEqual(seen.map(x=>x[1]),[{},{}]);status=503;await assert.rejects(client.modelScanInvalidate(),{status:503});
});
test('manager mutation fences scans started during the write after it settles (#2405)',async()=>{
 let generation=0,during;
 const service={modelScanCache:{clear:async()=>{generation++;}},invalidateModelReads:()=>{}};
 const handle=createModelRoutes({service,env:{MODEL_LOADER_URL:'http://synthetic'},modelManager:{},json:(_res,status,body)=>{assert.ok(generation>during,'the response waits for the settled-write fence');return {status,body};},readBody:async()=> '{}',fetchJson:async()=>{during=generation;return {ok:true,status:200,body:{ok:true}};}});
 const path='/api/model-manager/synthetic-write';
 await handle({method:'POST'},{setHeader(){}},{path,authn:{user:{role:'admin'}},url:new URL('http://synthetic'+path)});
 assert.ok(generation>during,'a scan captured during the mutation must be fenced after completion');
});
test('traversal and separators retain Node status and error before forwarding',async()=>{
 for(const tail of ['sections/a%2Fb','sections/a%5cb','sections/%2e%2e','sections/%','sections/%ff']){
  const path='/api/model-manager/'+tail;let answer;
  const h=createModelRoutes({service:{modelScanCache:{clear:async()=>{}}},env:{MODEL_LOADER_URL:'http://synthetic'},modelManager:{},json:(_res,status,body)=>{answer={status,body}},fetchJson:()=>{throw Error('must not forward')}});
  await h({method:'GET',url:path},{},{path:new URL('http://synthetic'+path).pathname,authn:{user:{role:'admin'}},url:new URL('http://synthetic')});
  assert.deepEqual(answer,{status:400,body:{error:'Invalid path'}});
 }
});
test('public refusal still owns only exact GET',()=>{
 const {refuseOwned}=require('./rust-model-manager-scan.cjs');let sent;
 const deps={parseRequestUrl:req=>new URL(req.url,'http://synthetic'),json:(_r,status,body)=>{sent={status,body};}};
 assert.equal(refuseOwned({method:'GET',url:'/api/model-manager/models?refresh=1'}, {},deps),true);assert.equal(sent.status,503);
 for(const [method,url] of [['HEAD','/api/model-manager/models'],['POST','/api/model-manager/models'],['GET','/api/model-manager/models/'],['GET','/api/model-manager/models/delete']])assert.equal(refuseOwned({method,url},{},deps),false);
});
