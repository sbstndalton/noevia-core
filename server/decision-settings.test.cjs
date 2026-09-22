'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createDecisionSettings}=require('./decision-settings.cjs');
const {createFeatures}=require('./features.cjs');
const {createFeatureRoutes}=require('./routes/features.cjs');
const {createSystemOneRouter}=require('./system-one-router.cjs');
function fixture(fetchImpl=async()=>Response.json({ready:true})) {
  const map=new Map(),store={get:k=>map.get(k),set:(k,v)=>map.set(k,v)};
  const settings=createDecisionSettings({store,env:{},fetchImpl});
  const features=createFeatures({store,env:{},availability:{stepSupervision:settings.unavailable,systemOneRouting:settings.unavailable}});
  return {store,settings,features};
}
test('saving shared settings unlocks both experiments immediately and persists restart',()=>{
  const {store,settings,features}=fixture();
  assert.throws(()=>features.set('systemOneRouting',true,'admin'),/Set up/);
  settings.save({url:'http://laya:8040',timeoutMs:900},'admin');
  for(const feature of ['stepSupervision','systemOneRouting']) {features.set(feature,true,'admin');assert.equal(features.enabled(feature),true);}
  assert.equal(createDecisionSettings({store,env:{}}).get().timeoutMs,900);
});
test('invalid settings leave active configuration intact',()=>{
  const {settings}=fixture();settings.save({url:'http://laya:8040',timeoutMs:1500},'admin');
  for(const value of [{url:'http://public.example',timeoutMs:500},{url:'http://laya:8040',timeoutMs:9999},{url:'http://laya:8040/?key=secret',timeoutMs:500}])assert.throws(()=>settings.save(value,'admin'));
  assert.equal(settings.get().url,'http://laya:8040');
});
test('connection test uses health only, rejects redirects/not-ready and never saves drafts',async()=>{
  let calls=0;const {settings}=fixture(async(url,init)=>{calls++;assert.equal(url,'http://laya:8040/health');assert.equal(init.redirect,'error');assert.ok(init.signal);return Response.json({ready:true});});
  assert.equal((await settings.test({url:'http://laya:8040',timeoutMs:500})).ok,true);assert.equal(settings.get().url,'');assert.equal(calls,1);
  for(const reply of [Response.json({ready:false}),new Response('',{status:302}),Response.json('x'.repeat(5000))]) {
    await assert.rejects(fixture(async()=>reply).settings.test({url:'http://laya:8040',timeoutMs:500}));
  }
});
test('Laya routing supports Fast/Smart choice and live endpoint replacement',async()=>{
  const urls=[];const {settings}=fixture(async(url,init)=>{urls.push(url);const body=JSON.parse(init.body);assert.deepEqual(body.options.map(o=>o.id),['fast','smart']);return Response.json({selected:'smart',scores:{fast:0.2,smart:0.8}});});
  settings.save({url:'http://laya:8040',timeoutMs:1000},'admin');
  const router=createSystemOneRouter({enabled:()=>true,roles:()=>({fast:'a',smart:'b'}),fallback:()=>assert.fail('Unexpected fallback'),getBackend:settings.backend,getDeadlineMs:()=>settings.get().timeoutMs});
  assert.equal(await router.classify('synthetic task'),'smart');
  settings.save({url:'http://127.0.0.1:8041',timeoutMs:1000},'admin');
  assert.equal(await router.classify('second tenant synthetic task'),'smart');
  assert.deepEqual(urls,['http://laya:8040/v1/decisions','http://127.0.0.1:8041/v1/decisions']);
});
test('only admins can read, save or test decision settings',async()=>{
  const {settings,features}=fixture();const route=createFeatureRoutes({features,decisionSettings:settings,json:(res,status,body)=>Object.assign(res,{status,body}),readJson:async req=>req.body});
  for(const method of ['GET','PUT','POST']){
    const res={};await route({method,body:{url:'http://laya:8040',timeoutMs:500}},res,{path:'/api/admin/decision-settings'+(method==='POST'?'/test':''),authn:{user:{id:'member',role:'member'}}});assert.equal(res.status,403);
  }
  const res={};await route({method:'PUT',body:{url:'http://laya:8040',timeoutMs:500}},res,{path:'/api/admin/decision-settings',authn:{user:{id:'admin',role:'admin'}}});assert.equal(res.status,200);
});
