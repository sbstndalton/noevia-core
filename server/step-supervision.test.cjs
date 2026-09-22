'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createStepSupervision,superviseNextStep}=require('./step-supervision.cjs');
const input={round:0,messages:[{role:'user',content:'private request'},{role:'assistant',content:'visible output',reasoning_content:'hidden'},{role:'tool',tool_call_id:'call-a',content:'result'}]};
const active=decide=>createStepSupervision({enabled:()=>true,provider:{decide},deadlineMs:10});
test('default off and absent provider preserve existing behavior',async()=>{
  for(const supervisor of [createStepSupervision(),createStepSupervision({provider:{decide:()=>{throw Error('off');}}})])
    assert.deepEqual(await supervisor.decide(input),{action:'continue',source:'existing'});
});
test('invalid, rejected and timed-out providers fall back without waiting indefinitely',async()=>{
  for(const decide of [async()=>({action:'approve_all'}),async()=>({action:'verify',prompt:'override'}),async()=>{throw Error('offline');},()=>new Promise(()=>{})])
    assert.deepEqual(await active(decide).decide(input),{action:'continue',source:'existing'});
});
test('projection is bounded, excludes reasoning and does not mutate canonical state',async()=>{
  const original=JSON.stringify(input);
  await active(async state=>{assert.equal(JSON.stringify(state).includes('hidden'),false);assert.equal(state.goal,'private request');state.outputs[0].content='changed';return {action:'continue'};}).decide(input);
  assert.equal(JSON.stringify(input),original);
});
test('cancel and final round never invoke the provider',async()=>{
  const supervisor=active(()=>{assert.fail('unexpected provider invocation');});
  await supervisor.decide({...input,signal:AbortSignal.abort()});await supervisor.decide({...input,round:2});
});
test('verification adds fixed instruction without modifying input; escalation only pauses',async()=>{
  const verified=await superviseNextStep(active(async()=>({action:'verify'})),input);
  assert.equal(input.messages.length,3);assert.equal(verified.messages.length,4);assert.equal(verified.pause,false);
  const escalated=await superviseNextStep(active(async()=>({action:'escalate'})),input);
  assert.equal(escalated.messages,input.messages);assert.equal(escalated.pause,true);
});
test('simultaneous requests have no shared state',async()=>{
  const supervisor=active(async s=>({action:s.outputs[0].content==='one'?'verify':'continue'}));
  const values=await Promise.all(['one','two'].map(content=>supervisor.decide({round:0,messages:[{role:'assistant',content}]})));
  assert.deepEqual(values.map(x=>x.action),['verify','continue']);
});
test('unconfigured experiment cannot be activated by setting or operator env',()=>{
  const {createFeatures}=require('./features.cjs');
  const features=createFeatures({env:{NOEVIA_FEATURE_STEP_SUPERVISION:'true'}});
  assert.equal(features.enabled('stepSupervision'),false);
  const normal=createFeatures({env:{},store:{get:()=>undefined,set:()=>assert.fail('must not persist activation')}});
  assert.throws(()=>normal.set('stepSupervision',true,'admin'),/Connect a private decision service/);
});
