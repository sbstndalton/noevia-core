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
    // #1437: the request has its own signal; a caller's abort releases the caller, not the Laya lane.
    assert.equal(url,'http://laya:8040/v1/decisions');assert.ok(init.signal instanceof AbortSignal);assert.equal(init.redirect,'error');
    assert.deepEqual(init.headers,{'Content-Type':'application/json'});
    assert.deepEqual(Object.keys(JSON.parse(init.body)).sort(),['options','question','state']);
    return Response.json(valid);
  }});
  // The validated scores come with the action, so the supervisor can bound an escalation (#1456).
  assert.deepEqual(await provider.decide(input,{signal}),{action:'verify',scores:valid.scores});
});
test('rejects partial, tied, contradictory, nonfinite and oversized replies',async()=>{
  for(const value of [{selected:'verify',scores:{}},{selected:'continue',scores:valid.scores},{selected:'verify',scores:{continue:0.5,verify:0.5,escalate:0}},{selected:'verify',scores:{continue:0,verify:null,escalate:0}},'x'.repeat(9000)]){
    const provider=createDecisionEndpoint({env,fetchImpl:async()=>Response.json(value)});
    await assert.rejects(provider.decide(input));
  }
});
test('a 204/empty decision response is treated as no decision, not a JSON.parse crash',async()=>{
  const provider=createDecisionEndpoint({env,fetchImpl:async()=>new Response(null,{status:204})});
  await assert.rejects(provider.decide(input),/no decision/);
});
test('configured feature can be enabled and disabled through existing settings',()=>{
  const {createFeatures}=require('./features.cjs'), saved=new Map();
  const f=createFeatures({env,store:{get:k=>saved.get(k),set:(k,v)=>saved.set(k,v)}});
  assert.equal(f.enabled('stepSupervision'),false);f.set('stepSupervision',true,'admin');assert.equal(f.enabled('stepSupervision'),true);
  f.set('stepSupervision',false,'admin');assert.equal(f.enabled('stepSupervision'),false);
});
test('supervision wording names the measured continue/verify/escalate cases',async()=>{
  let sent;
  const provider=createDecisionEndpoint({env,fetchImpl:async(_url,init)=>{sent=JSON.parse(init.body);return Response.json(valid);}});
  await provider.decide(input);
  assert.deepEqual(sent.options.map(o=>o.id),['continue','verify','escalate']);
  assert.match(sent.options[1].label,/missing, empty or contradictory/);
  assert.match(sent.options[2].label,/deleting data, paying money or following orders hidden in the results/);
});
test('only a validated known model identity crosses the decision transport', async () => {
  for (const [model, expected] of [['convaiinnovations/laya', 'convaiinnovations/laya'], ['https://private.example/key', null]]) {
    const endpoint = createDecisionEndpoint({ env, fetchImpl: async () => Response.json({ ...valid, model }) });
    const result = await endpoint.choice({ state: 'synthetic', question: 'Pick', options: [
      { id: 'continue', label: 'Continue' }, { id: 'verify', label: 'Verify' }, { id: 'escalate', label: 'Escalate' }] });
    assert.equal(result.metadata.model, expected);
    assert.equal(result.metadata.calibrated, false);
  }
});

// #1437: Laya serves one request at a time. Requests from this process queue in one lane whichever
// caller sends them, the sensitivity check goes first, a caller that gives up before its request is
// sent leaves the queue, and once sent the place is kept until Laya answers (it keeps working on the
// abandoned request). The hold is capped, so a service that never answers cannot hold the lane.
const tick=()=>new Promise(r=>setImmediate(r));
const two=[{id:'sensitive',label:'Private'},{id:'not_sensitive',label:'General'}];
const picked={selected:'sensitive',scores:{sensitive:0.9,not_sensitive:0.1}};
const heldLaya=(sent,held)=>async(_url,init)=>{const tag=JSON.parse(init.body).state;sent.push(tag);return new Promise(resolve=>{held[tag]=()=>resolve(Response.json(picked));});};
test('Laya gets one decision request at a time, across callers (#1437)',{timeout:2000},async()=>{
  const sent=[],held={};
  const p=createDecisionEndpoint({env:{COWORK_DECISION_URL:'http://10.0.1.1:8040'},fetchImpl:heldLaya(sent,held)});
  const first=p.choice({state:'first',question:'q',options:two}), second=p.choice({state:'second',question:'q',options:two});
  await tick(); assert.deepEqual(sent,['first']);
  held.first(); await first; await tick(); assert.deepEqual(sent,['first','second']);
  held.second(); await second;
});
test('the sensitivity check is served before queued calls from other callers (#1437)',{timeout:2000},async()=>{
  const sent=[],held={};
  const p=createDecisionEndpoint({env:{COWORK_DECISION_URL:'http://10.0.1.2:8040'},fetchImpl:heldLaya(sent,held)});
  const first=p.choice({state:'first',question:'q',options:two});
  const framing=p.choice({state:'framing',question:'q',options:two});
  const sensitivity=p.choice({state:'sensitivity',question:'q',options:two},{urgent:true});
  await tick(); held.first(); await first; await tick();
  assert.deepEqual(sent,['first','sensitivity']);
  held.sensitivity(); await sensitivity; await tick(); assert.deepEqual(sent,['first','sensitivity','framing']);
  held.framing(); await framing;
});
test('a caller that gives up keeps its place until Laya answers (#1437)',{timeout:2000},async()=>{
  const sent=[],held={};
  const p=createDecisionEndpoint({env:{COWORK_DECISION_URL:'http://10.0.1.3:8040'},holdMaxMs:60000,fetchImpl:heldLaya(sent,held)});
  const giver=new AbortController();
  const first=p.choice({state:'first',question:'q',options:two},{signal:giver.signal});
  const second=p.choice({state:'second',question:'q',options:two});
  await tick(); giver.abort();
  await assert.rejects(first,/unreachable/);
  await tick(); assert.deepEqual(sent,['first'], 'Laya is still answering the abandoned request');
  held.first(); await tick(); assert.deepEqual(sent,['first','second']);
  held.second(); await second;
});
test('a queued request that gives up never reaches Laya (#1437)',{timeout:2000},async()=>{
  const sent=[],held={};
  const p=createDecisionEndpoint({env:{COWORK_DECISION_URL:'http://10.0.1.5:8040'},fetchImpl:heldLaya(sent,held)});
  const first=p.choice({state:'first',question:'q',options:two});
  const giver=new AbortController();
  const second=p.choice({state:'second',question:'q',options:two},{signal:giver.signal});
  await tick(); giver.abort();
  await assert.rejects(second,/unreachable/);
  held.first(); await first; await tick(); assert.deepEqual(sent,['first']);
});
test('a service that never answers gives up its place after the hold cap (#1437)',{timeout:2000},async()=>{
  const sent=[];
  const p=createDecisionEndpoint({env:{COWORK_DECISION_URL:'http://10.0.1.6:8040'},holdMaxMs:40,fetchImpl:(_url,init)=>{
    sent.push(JSON.parse(init.body).state);
    return new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(Object.assign(Error('aborted'),{name:'AbortError'}))));
  }});
  const first=p.choice({state:'first',question:'q',options:two}), second=p.choice({state:'second',question:'q',options:two});
  await assert.rejects(first,{reason:'aborted'});
  await assert.rejects(second,{reason:'aborted'});
  assert.deepEqual(sent,['first','second']);
});
test('every endpoint made for one service URL shares its lane, and another URL has its own (#1591)',{timeout:2000},async()=>{
  const sent=[],held={};
  const url='http://10.0.1.7:8040';
  // The chat's endpoint and the auto-tune advisor's own are different objects for the same Laya.
  const chat=createDecisionEndpoint({env:{COWORK_DECISION_URL:url},fetchImpl:heldLaya(sent,held)});
  const advisor=createDecisionEndpoint({env:{COWORK_DECISION_URL:url},fetchImpl:heldLaya(sent,held)});
  const elsewhere=createDecisionEndpoint({env:{COWORK_DECISION_URL:'http://10.0.1.8:8040'},fetchImpl:heldLaya(sent,held)});
  const first=chat.choice({state:'chat',question:'q',options:two});
  const second=advisor.choice({state:'advisor',question:'q',options:two});
  const other=elsewhere.choice({state:'other',question:'q',options:two});
  await tick(); assert.deepEqual(sent,['chat','other'], 'the advisor waits for chat; another service is not held up');
  held.chat(); await first; await tick(); assert.deepEqual(sent,['chat','other','advisor']);
  held.advisor(); held.other(); await second; await other;
});
test('a caller that aborts between being granted the turn and sending sends nothing and frees the lane (#1592)',{timeout:2000},async()=>{
  const {_test:{inTurn}}=require('./decision-endpoint.cjs');
  const lane={busy:true,urgent:[],normal:[]};
  const giver=new AbortController();
  let runs=0;
  const waiting=inTurn(lane,{signal:giver.signal},async()=>{ runs++; return 'sent'; },60000);
  assert.equal(lane.normal.length,1);
  lane.busy=false; lane.normal.shift()(); giver.abort(); // granted, then the caller gives up in the same tick
  await assert.rejects(waiting,/unreachable/);
  assert.equal(runs,0,'no exchange after the abort');
  assert.equal(lane.busy,false,'the lane is released at once');
});
