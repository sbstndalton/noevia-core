'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createStepSupervision,superviseNextStep}=require('./step-supervision.cjs');
const input={round:0,messages:[{role:'user',content:'private request'},{role:'assistant',content:'visible output',reasoning_content:'hidden'},{role:'tool',tool_call_id:'call-a',content:'result'}]};
const active=decide=>createStepSupervision({enabled:()=>true,provider:{decide},deadlineMs:10,log:()=>{}});
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
  // A round that wrote (#1456): its escalation is honoured without any score.
  const escalated=await superviseNextStep(active(async()=>({action:'escalate'})),{...input,wrote:true});
  assert.equal(escalated.messages,input.messages);assert.equal(escalated.pause,true);
});
// #1456: 'escalate' is a three-way argmax, so on a read-only round it pauses only when the classifier is confident.
test('a read-only round pauses on a confident escalation and not on a weak one (#1456)',async()=>{
  const lines=[];
  const confident=createStepSupervision({enabled:()=>true,provider:{decide:async()=>({action:'escalate',scores:{continue:0.1,verify:0.2,escalate:0.7}})},deadlineMs:50,log:e=>lines.push(e)});
  assert.equal((await superviseNextStep(confident,input)).pause,true);
  const weak=createStepSupervision({enabled:()=>true,provider:{decide:async()=>({action:'escalate',scores:{continue:0.3,verify:0.3,escalate:0.4}})},deadlineMs:50,log:e=>lines.push(e)});
  const out=await superviseNextStep(weak,input);
  assert.equal(out.pause,false);assert.equal(out.messages,input.messages);
  assert.deepEqual(out.decision,{action:'continue',source:'existing'});
  assert.deepEqual(lines.at(-1),{round:0,action:'continue',fellBack:'weak-escalate',cause:null});
});
test('the escalation bound is inclusive at its edges and needs a clear margin (#1456)',async()=>{
  const pauses=async scores=>(await superviseNextStep(createStepSupervision({enabled:()=>true,provider:{decide:async()=>({action:'escalate',scores})},deadlineMs:50,log:()=>{}}),input)).pause;
  assert.equal(await pauses({continue:0,verify:0.3,escalate:0.6}),true,'exactly 0.6 with a 0.3 margin');
  assert.equal(await pauses({continue:0,verify:0.35,escalate:0.65}),true,'exactly 0.3 margin at 0.65');
  assert.equal(await pauses({continue:0.05,verify:0.35,escalate:0.6}),false,'0.6 against 0.35 is only a 0.25 margin');
  assert.equal(await pauses({continue:0.2,verify:0.2,escalate:0.6}),true,'0.6 with a 0.4 margin');
  assert.equal(await pauses({continue:0,verify:0.4,escalate:0.6}),false,'a 0.6-vs-0.4 split is weak');
  assert.equal(await pauses({continue:0.25,verify:0.2,escalate:0.55}),false,'0.55 is under the absolute bound');
  assert.equal(await pauses({continue:0.1,verify:0.1,escalate:0.8}),true);
});
test('a read-only round whose stop verdict has no scores is not a stop (#1456)',async()=>{
  for(const value of [{action:'escalate'},{action:'escalate',scores:'x'},{action:'escalate',scores:{escalate:0.9}}]){
    const out=await superviseNextStep(active(async()=>value),input);
    assert.equal(out.pause,false,JSON.stringify(value));
  }
  // The same verdict on a round that wrote still pauses.
  assert.equal((await superviseNextStep(active(async()=>({action:'escalate'})),{...input,wrote:true})).pause,true);
});
test('simultaneous requests have no shared state',async()=>{
  const supervisor=active(async s=>({action:s.outputs[0].content==='one'?'verify':'continue'}));
  const values=await Promise.all(['one','two'].map(content=>supervisor.decide({round:0,messages:[{role:'assistant',content}]})));
  assert.deepEqual(values.map(x=>x.action),['verify','continue']);
});
test('unconfigured experiment cannot be activated by setting or operator env',()=>{
  const {createFeatures}=require('../tests/server/oracles/features-legacy.cjs');
  const features=createFeatures({env:{NOEVIA_FEATURE_STEP_SUPERVISION:'true'}});
  assert.equal(features.enabled('stepSupervision'),false);
  const normal=createFeatures({env:{},store:{get:()=>undefined,set:()=>assert.fail('must not persist activation')}});
  assert.throws(()=>normal.set('stepSupervision',true,'admin'),/Connect a private decision service/);
});
test('supervision logs the action and fallback without message content', async()=>{
  const lines=[];
  const s=createStepSupervision({enabled:()=>true,provider:{decide:async()=>({action:'verify'})},deadlineMs:50,log:e=>lines.push(e)});
  await s.decide({round:0,messages:[{role:'user',content:'synthetic private goal'},{role:'tool',content:'x'}]});
  assert.deepEqual(lines,[{round:0,action:'verify',fellBack:null}]);
});
test('supervision deadline cap is 2000 ms (#682)',async()=>{
  assert.doesNotThrow(()=>createStepSupervision({deadlineMs:2000}));
  assert.throws(()=>createStepSupervision({deadlineMs:2001}),/Invalid supervision deadline/);
  let called=0;
  const provider={decide:async()=>{called++;return {action:'verify'};}};
  const at=ms=>createStepSupervision({enabled:()=>true,provider,getDeadlineMs:()=>ms,log:()=>{}});
  assert.equal((await at(2000).decide(input)).action,'verify');
  assert.deepEqual(await at(2001).decide(input),{action:'continue',source:'existing'});
  assert.equal(called,1);
});

test('an explicit goal from the caller wins over the last user message (#1441)',async()=>{
  const goals=[];
  const attached={round:0,goal:'Summarize this file.',messages:[{role:'user',content:'The user attached these files to this chat (1): "a.md"\n<untrusted>file text</untrusted>\n\nSummarize this file.'},{role:'tool',tool_call_id:'c',content:'result'}]};
  await active(async s=>{goals.push(s.goal);return {action:'continue'};}).decide(attached);
  await active(async s=>{goals.push(s.goal);return {action:'continue'};}).decide({...attached,goal:undefined});
  assert.equal(goals[0],'Summarize this file.');
  assert.match(goals[1],/^The user attached/,'without one it still reads the last user message');
});
