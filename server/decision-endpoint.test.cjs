'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {configuration,createDecisionEndpoint}=require('./decision-endpoint.cjs');
const env={COWORK_DECISION_URL:'http://laya:8040'};
const input={goal:'synthetic task',outputs:[{role:'tool',content:'result'}]};
const valid={selected:'verify',scores:{continue:0.1,verify:0.8,escalate:0.1}};
test('private operator endpoint only; no credentials or remote origin accepted',()=>{
  for(const url of ['https://api.openai.com','http://user:pass@laya:8040','http://laya:8040/?key=secret','http://169.254.169.254','http://example.com']) assert.ok(configuration({COWORK_DECISION_URL:url}).reason);
  assert.equal(configuration(env).reason,null);
});
test('typed decision transport has no answering provider identity or credentials',async()=>{
  const signal=new AbortController().signal;
  const provider=createDecisionEndpoint({env,fetchImpl:async(url,init)=>{
    assert.equal(url,'http://laya:8040/v1/decisions');assert.equal(init.signal,signal);assert.equal(init.redirect,'error');
    assert.deepEqual(init.headers,{'Content-Type':'application/json'});
    assert.deepEqual(Object.keys(JSON.parse(init.body)).sort(),['options','question','state']);
    return Response.json(valid);
  }});
  assert.deepEqual(await provider.decide(input,{signal}),{action:'verify'});
});
test('rejects partial, tied, contradictory, nonfinite and oversized replies',async()=>{
  for(const value of [{selected:'verify',scores:{}},{selected:'continue',scores:valid.scores},{selected:'verify',scores:{continue:0.5,verify:0.5,escalate:0}},{selected:'verify',scores:{continue:0,verify:null,escalate:0}},'x'.repeat(9000)]){
    const provider=createDecisionEndpoint({env,fetchImpl:async()=>Response.json(value)});
    await assert.rejects(provider.decide(input));
  }
});
test('configured feature can be enabled and disabled through existing settings',()=>{
  const {createFeatures}=require('./features.cjs'), saved=new Map();
  const f=createFeatures({env,store:{get:k=>saved.get(k),set:(k,v)=>saved.set(k,v)}});
  assert.equal(f.enabled('stepSupervision'),false);f.set('stepSupervision',true,'admin');assert.equal(f.enabled('stepSupervision'),true);
  f.set('stepSupervision',false,'admin');assert.equal(f.enabled('stepSupervision'),false);
});
