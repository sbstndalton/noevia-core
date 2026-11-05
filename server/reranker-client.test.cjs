'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {createClient,install,current,withSettings}=require('./rerank-settings.cjs');
const env={NOEVIA_PROJECT_STORE_PORT:'19091',NOEVIA_PROJECT_STORE_TOKEN:'x'.repeat(32)};
const snapshot=(model)=>({revision:'0'.repeat(32)+':0',env:{RERANK_API_KEY:'',RERANK_MODEL:model,NOEVIA_FEATURE_RAG_RERANK:'true'},view:{enabled:true,choice:'tei',source:'admin',options:[]}});
test('native owner unavailable never falls back to deployment',async()=>{
 const client=createClient({env,fetchImpl:async()=>{throw Error('synthetic outage');}});
 await assert.rejects(client.run(()=>assert.fail('must not execute')),e=>e.status===503);
 assert.throws(()=>client.effectiveEnv(),e=>e.status===503);
});
test('concurrent operations retain their own native snapshot and the next use rereads',async()=>{
 let count=0;const client=createClient({env,fetchImpl:async()=>new Response(JSON.stringify(snapshot(String(++count))))});
 const a=client.run(async()=>{await new Promise(r=>setImmediate(r));return client.effectiveEnv().RERANK_MODEL;});
 const b=client.run(()=>client.effectiveEnv().RERANK_MODEL);
 assert.deepEqual(await Promise.all([a,b]),['1','2']);
 assert.equal(await client.run(()=>client.effectiveEnv().RERANK_MODEL),'3');
});
test('bad or oversized authority responses refuse before executing work',async()=>{
 for(const response of [new Response('{}'),new Response('no',{status:503}),new Response('x'.repeat(1024*1024+1)),new Response(JSON.stringify({...snapshot('synthetic'),env:{}}))]){
  const client=createClient({env,fetchImpl:async()=>response});await assert.rejects(client.run(()=>assert.fail()),e=>e.status===503);
 }
});
test('private native request carries only the supplied synthetic catalogue and token',async()=>{
 let seen;const client=createClient({env,fetchImpl:async(url,options)=>{seen={url,options};return new Response(JSON.stringify(snapshot('synthetic')));}});
 await client.get([{name:'synthetic'}]);
 assert.equal(seen.url,'http://127.0.0.1:19091/v1/reranker/settings');
 assert.equal(seen.options.redirect,'error');
 assert.deepEqual(JSON.parse(seen.options.body),{installed:[{name:'synthetic'}]});
 assert.equal(seen.options.headers['x-noevia-store-token'],env.NOEVIA_PROJECT_STORE_TOKEN);
});
test('installed consumer refuses when authority is unreachable',async()=>{
 const prior=current();install(createClient({env,fetchImpl:async()=>{throw Error();}}));
 try {await assert.rejects(withSettings(()=>assert.fail()),e=>e.status===503);}finally{install(prior);}
});
test('model protection follows the next native selection and retains deployment seeds',async()=>{
 const prior=current();let count=0;
 const client=createClient({env,fetchImpl:async()=>new Response(JSON.stringify(snapshot(`synthetic-${++count}`)))});
 install(client);
 try {
  const names=require('./model-system.cjs').rerankModelNames;
  const seed={NOEVIA_FEATURE_RAG_RERANK:'true',RERANK_MODEL:'synthetic-seed'};
  assert.deepEqual([...await withSettings(()=>names(seed))],['synthetic-seed','synthetic-1']);
  assert.deepEqual([...await withSettings(()=>names(seed))],['synthetic-seed','synthetic-2']);
 }finally{install(prior);}
});
test('a changed native selection invalidates existing model reads before work starts',async()=>{
 let model='synthetic-a',changes=0;
 const client=createClient({env,fetchImpl:async()=>new Response(JSON.stringify(snapshot(model))),onChange:()=>changes++});
 await client.run(()=>assert.equal(changes,1));
 await client.run(()=>assert.equal(changes,1));
 model='synthetic-b';await client.run(()=>assert.equal(changes,2));
});

test('an identical native save still invalidates consumers through its mutation sequence',async()=>{
 let revision=0,changes=0;
 const client=createClient({env,fetchImpl:async()=>new Response(JSON.stringify({...snapshot('synthetic'),revision:'0'.repeat(32)+':'+revision})),onChange:()=>changes++});
 await client.run(()=>{});revision++;await client.run(()=>{});assert.equal(changes,2);
});
test('existing model action permissions precede native settings availability',async()=>{
 const prior=current();let reads=0;
 install(createClient({env,fetchImpl:async()=>{reads++;throw Error('synthetic outage');}}));
 try {
  const {createModelRoutes}=require('./routes/models.cjs');let response;
  const route=createModelRoutes({json:(_r,status,body)=>{response={status,body};},env:{},modelManager:{},service:{modelScanCache:{clear(){}}}});
  const p='/api/model-manager/sections/synthetic';
  const request={method:'PUT',url:p,headers:{}};
  const context=role=>({path:p,url:new URL(p,'http://synthetic.invalid'),authn:{user:{id:'synthetic',role}}});
  await route(request,{},context('member'));
  assert.equal(response.status,403);assert.equal(reads,0);
  await assert.rejects(route(request,{},context('admin')),e=>e.status===503);
  assert.equal(reads,1);
 }finally{install(prior);}
});
