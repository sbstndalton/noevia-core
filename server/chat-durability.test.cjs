'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {EventEmitter}=require('node:events');
const {createChatHandler}=require('./chat.cjs');
const {createToolExchange}=require('./tool-exchange.cjs');
const {createVisionProbe}=require('./vision.cjs');
const {createChatTurns}=require('./chat-turns.cjs');
async function run(t,ambiguous=false,stepSupervision=null,providerId='default',streamError=false) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'noevia-chat-durable-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const userId='synthetic-user',projectId='fixture-project',service=createChatTurns({enabled:true});
  const events=[],res=new EventEmitter();res.writeHead=()=>{};res.write=line=>events.push(JSON.parse(line.slice(6)));res.end=()=>{res.writableEnded=true;res.emit('finish');};
  let requests=0,executions=0;
  const fetch=async()=>{requests++;if(requests>1&&streamError)return {ok:true,body:(async function*(){yield Buffer.from('data: '+JSON.stringify({error:{message:'synthetic provider overload'}})+'\n\n');})()};if(requests>1)throw Error('mock model died');return {ok:true,body:(async function*(){yield Buffer.from('data: '+JSON.stringify({choices:[{delta:{content:'Preamble',tool_calls:[{index:0,id:'call-fixture',function:{name:'synthetic_write',arguments:'{}'}}]}}]})+'\n\n');})()};};
  const context = {
    modelManager:{enabled:true,health:async()=>({ok:true,body:{all_models_loaded:[{model_name:'answer-model',loaded:true,recipe_options:{ctx_size:32768}}]}})},
    reasoningEffort: require('./reasoning-effort.cjs'),
    authService: {audit() {}},
    crypto: require('node:crypto'), path, fetch,
    fs,
    HISTORY_CAP: 20, DEFAULT_PROVIDER_ID: 'default', createToolExchange,
    currentWorkspace: () => ({ userId, dir, assetDir: () => '/synthetic-only' }),
    getProject: () => ({id:projectId,model:'answer-model',assets:[]}),
    skillsIndexFor: () => [], getProvider: () => ({ id: providerId, baseUrl: 'http://fixture.invalid' }),
    providerHeaders: () => ({}), autoRoles: () => null,
    visionDescriptions: new Map(), visionProbe: createVisionProbe({ fetchImpl: fetch }),
    chatSkillRouter: { select: async () => ({ loaded: [] }) }, oauthServerIds: () => new Set(), accountReady: () => true, mcpOAuth: { connected: () => false }, chatToolRouter: { select: async (ids) => ({ ids, routed: false }) }, DEFAULT_TOOLBOXES: [],
    CONNECTOR_BOXES: new Set(['gdrive']), connectedBoxes: () => [], toolPolicy: { mode: (_user, _name, write) => (write ? 'ask' : 'allow') }, requestScope: { getStore: () => ({}) },
    resolveTools: () => ({ tools: [{type:'function',function:{name:'synthetic_write',parameters:{type:'object'}}}], dropped: [] }), isWriteTool: () => true,
  };
  const { handleChat } = createChatHandler({
    rag: { filesContext: async () => null }, prefill: { recordSample() {} }, reduceToolResult: () => ({ text:'reduced' }), diaryExtras: require('./diary-extras.cjs'),
    DIARY_BASE: 'http://fixture.invalid', TOOL_RESULT_CAP: 8000, json: () => {}, saveChats() {}, endpointApproved: () => true, diaryHeaders: () => ({}),
    lastLoadedModel: () => null, classifyFastOrSmart: async () => 'fast', servedCatalogue: async () => [], modelsInstalled: async () => [], missingRoles: () => [], staleRolesError: () => null,
    allToolboxes: () => [], executeToolCall: async () => { executions++; if (ambiguous) throw Error('connection lost after write'); return 'complete synthetic result'; }, chatWideApproved: () => false, awaitApproval: async ({onDecision}) => {onDecision('approve_all'); return 'approve';}, recordUsage() {}, recordToolUse() {},
    ...context, durableChat:service, stepSupervision,
  });
  await handleChat({},res,{projectId,chatId:'fixture-chat',message:'synthetic write'});
  const job=require('./jobs.cjs').createJobs({dir}).list({kind:'chat'})[0];
  return {service,workspace:{dir,userId},id:job.id,executions,requests,events};
}
test('real chat loop checkpoints a tool result before model failure and restores with a fake provider',async t=>{
  const f=await run(t);assert.equal(f.executions,1);assert.equal(f.requests,2);
  const restored=createChatTurns({enabled:true}).restore(f.workspace,f.id);
  assert.equal(restored.next,'generate');assert.match(restored.state.calls[0].result,/^<untrusted kind="tool result"[^\n]*\nreduced\n<\/untrusted>$/); // the model's copy is what replays
  assert.equal(restored.state.calls[0].resultBytes,Buffer.byteLength('complete synthetic result'));
  assert.equal(restored.state.calls[0].approval.action,'approve_all');
  assert.match(restored.state.projection.messages.at(-1).content,/\nreduced\n<\/untrusted>$/);
  await f.service.resumeGeneration(f.workspace,f.id,{model:{id:'replacement'},project:s=>s.messages,provider:async()=>({content:'Recovered without re-running the tool'})});
  assert.equal(f.executions,1);
});
test('a provider stream error marks the durable turn interrupted with its reason (#129)',async t=>{
  const f=await run(t,false,null,'default',true);assert.equal(f.requests,2);
  assert.ok(f.events.some(e=>e.type==='error'));
  const state=f.service.restore(f.workspace,f.id).state;
  assert.equal(state.phase,'interrupted');
  assert.match(state.failure,/^Provider stream error: The model stream failed/,'the specific reason, not the generic end-of-request one');
});
test('real chat loop preserves an ambiguous tool exception and stops before another model request',async t=>{
  const f=await run(t,true);assert.equal(f.executions,1);assert.equal(f.requests,1);
  assert.equal(f.service.restore(f.workspace,f.id).next,'review');
  await assert.rejects(f.service.resumeGeneration(f.workspace,f.id,{}),/review/);
});

test('supervision escalation persists review, preserves approval and never repeats a write',async t=>{
  const supervisor=require('./step-supervision.cjs').createStepSupervision({enabled:()=>true,provider:{decide:async()=>({action:'escalate'})}});
  const f=await run(t,false,supervisor);
  assert.equal(f.requests,1);assert.equal(f.executions,1);
  const restored=f.service.restore(f.workspace,f.id);
  assert.equal(restored.next,'review');assert.equal(restored.state.calls[0].approval.action,'approve_all');
  assert.equal(restored.state.supervision[0].action,'escalate');
  await assert.rejects(f.service.resumeGeneration(f.workspace,f.id,{}),/review/);
});
test('verification changes projection only; canonical tools and retry budget survive',async t=>{
  const supervisor=require('./step-supervision.cjs').createStepSupervision({enabled:()=>true,provider:{decide:async()=>({action:'verify'})}});
  const f=await run(t,false,supervisor),s=f.service.restore(f.workspace,f.id).state;
  assert.equal(f.requests,2);assert.equal(f.executions,1);assert.equal(s.retries.remaining,1);
  assert.match(s.projection.messages.at(-1).content,/Check the preceding/);
  assert.match(s.messages.at(-1).content,/\nreduced\n<\/untrusted>$/);
});
test('ambiguous tool outcomes bypass supervision',async t=>{
  const f=await run(t,true,{decide:async()=>{throw Error('must not supervise unresolved write');}});
  assert.equal(f.requests,1);assert.equal(f.service.restore(f.workspace,f.id).next,'review');
});

for (const providerId of ['openrouter-fixture','openai-fixture']) {
  test(`supervision keeps the selected ${providerId} answering provider`,async t=>{
    const supervisor=require('./step-supervision.cjs').createStepSupervision({enabled:()=>true,provider:{decide:async()=>({action:'verify'})}});
    const f=await run(t,false,supervisor,providerId);
    assert.equal(f.service.restore(f.workspace,f.id).state.model.providerId,providerId);
    assert.equal(f.executions,1);assert.equal(f.requests,2);
  });
}
