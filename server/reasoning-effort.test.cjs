const test=require('node:test'),assert=require('node:assert/strict');
const {validEffort,resolveEffort,modeFor,requestBody,requestWithEffort}=require('./reasoning-effort.cjs');
const {effectiveCapabilities,parseCapabilities}=require('./providers.cjs');
// Fixture: a provider whose capability data declares a real parameter for one model.
const CAPS={reasoningEffortParam:true,reasoningEffortModels:['gpt-5.4'],tokenBudgetField:'max_completion_tokens'};
const provider={id:'fixture',baseUrl:'https://cloud.fixture.invalid/v1',apiKey:'synthetic-key',capabilities:CAPS};
const body={model:'gpt-5.4',messages:[{role:'user',content:'Synthetic question'}],stream:true,tools:[{type:'function',function:{name:'read'}}]};
test('project explicit default overrides global high; missing and invalid settings inherit safely',()=>{
 assert.equal(resolveEffort({reasoningEffort:'default'},'high'),'default');
 assert.equal(resolveEffort({reasoningEffort:'low'},'high'),'low');
 assert.equal(resolveEffort({},'high'),'high');assert.equal(resolveEffort({},'bogus'),'default');
 assert.equal(validEffort('medium'),false);assert.equal(validEffort(null),false);
});
test('only a flagged provider and a listed model receive a parameter',()=>{
 assert.equal(modeFor(provider,'gpt-5.4','high'),'real');
 assert.equal(modeFor({...provider,capabilities:{...CAPS,reasoningEffortParam:false}},'gpt-5.4','high'),'hint');
 assert.equal(modeFor({...provider,capabilities:undefined},'gpt-5.4','high'),'hint');
 assert.equal(modeFor({...provider,baseUrl:'http://localhost:13305/v1',capabilities:{}},'gpt-5.4','high'),'hint');
 assert.equal(modeFor(provider,'unverified-model','high'),'hint');assert.equal(modeFor(provider,'gpt-5.4','default'),'off');
 assert.equal(modeFor({...provider,capabilities:{reasoningEffortParam:true}},'any-model','low'),'real');
});
test('token budget field comes from provider data',()=>{
 const other={...provider,capabilities:{tokenBudgetField:'max_tokens'}};
 assert.equal(requestBody(body,'high','hint',other).max_tokens,8192);
 assert.equal(requestBody(body,'high','hint',{...provider,capabilities:{tokenBudgetField:'max_completion_tokens'},baseUrl:'http://x.invalid'}).max_completion_tokens,8192);
});
test('existing preset rows without capabilities keep the old behaviour via preset data',()=>{
 const legacy={id:'legacy',baseUrl:'https://api.openai.com/v1',apiKey:'k'};
 const eff={...legacy,capabilities:effectiveCapabilities(legacy)};
 assert.equal(modeFor(eff,'gpt-5.4','high'),'real');assert.equal(modeFor(eff,'other','high'),'hint');
 assert.equal(requestBody(body,'high','hint',eff).max_completion_tokens,8192);
 for(const u of ['https://api.openai.com.evil.test/v1','http://api.openai.com/v1','https://api.openai.com/custom','http://localhost:13305/v1']){
  const e={...legacy,baseUrl:u,capabilities:effectiveCapabilities({baseUrl:u})};assert.equal(modeFor(e,'gpt-5.4','high'),'hint',u);
 }
 assert.equal(effectiveCapabilities({baseUrl:'https://api.openai.com/custom'}).tokenBudgetField,'max_completion_tokens');
 assert.deepEqual(effectiveCapabilities({baseUrl:'https://api.openai.com/v1',capabilities:{}}),{});
});
test('capability input is validated',()=>{
 assert.deepEqual(parseCapabilities(CAPS).value,CAPS);
 for(const bad of [null,[],'x',{bogus:1},{reasoningEffortParam:'yes'},{tokenBudgetField:'n'},{reasoningEffortModels:'a'},{reasoningEffortModels:['']}])assert.ok(parseCapabilities(bad).error,JSON.stringify(bad));
});
test('reasoning-effort.cjs names no vendor host or model',()=>{
 const src=require('node:fs').readFileSync(require('node:path').join(__dirname,'reasoning-effort.cjs'),'utf8');
 assert.doesNotMatch(src,/api\.openai\.com/);assert.doesNotMatch(src,/gpt-/i);
});
test('default preserves the body; hints preserve raw messages/tools and bound output explicitly',()=>{
 assert.equal(requestBody(body,'default','off'),body);
 const hint=requestBody(body,'high','hint');assert.equal(hint.max_tokens,8192);assert.equal(hint.reasoning_effort,undefined);
 assert.equal(hint.messages[1],body.messages[0]);assert.equal(hint.tools,body.tools);assert.equal(body.messages.length,1);
 assert.equal(requestBody(body,'low','hint').max_tokens,undefined);
 assert.equal(requestBody({...body,max_tokens:16000},'high','hint').max_tokens,16000);
 assert.equal(requestBody(body,'low','real').reasoning_effort,'low');
});
for(const stream of [true,false])test(`field rejection retries once and remembers the credential/model scope (stream=${stream})`,async()=>{
 const p={...provider,apiKey:'fixture-rejection-'+stream},requests=[],events=[];
 const fetcher=async(_,options)=>{requests.push(JSON.parse(options.body));return requests.length===1?new Response('{"error":"reasoning_effort unsupported"}',{status:422}):new Response('{}');};
 const result=await requestWithEffort(fetcher,'https://fixture.invalid',{}, {...body,stream},p,'gpt-5.4','high',e=>events.push(e));
 assert.equal(result.status,200);assert.equal(requests.length,2);assert.equal(requests[0].reasoning_effort,'high');assert.equal(requests[1].reasoning_effort,undefined);assert.equal(requests[1].max_completion_tokens,8192);assert.equal(requests[1].stream,stream);
 assert.equal(modeFor(p,'gpt-5.4','high'),'hint');assert.equal(modeFor({...p,apiKey:'different-key'},'gpt-5.4','high'),'real');assert.equal(events.at(-1).reasoning,'hint');assert.equal(events.filter(e=>e.type==='warning').length,1);
});
test('unrelated errors never trigger retry or capability demotion',async()=>{
 const p={...provider,apiKey:'fixture-unrelated'};let count=0;
 const response=await requestWithEffort(async()=>{count++;return new Response('invalid tools',{status:400});},'https://fixture.invalid',{},body,p,'gpt-5.4','low',()=>{});
 assert.equal(response.status,400);assert.equal(count,1);assert.equal(modeFor(p,'gpt-5.4','low'),'real');
});
test('abort propagates without an automatic retry',async()=>{
 let count=0;await assert.rejects(requestWithEffort(async()=>{count++;throw new Error('aborted');},'https://fixture.invalid',{},body,provider,'gpt-5.4','low',()=>{}),/aborted/);assert.equal(count,1);
});

test('OpenAI hint mode uses the completion budget field accepted by reasoning models',()=>{
 const result=requestBody(body,'high','hint',provider);
 assert.equal(result.max_completion_tokens,8192);assert.equal(result.max_tokens,undefined);
});

test('unverified output-budget rejection falls back once without breaking hint chat',async()=>{
 const p={id:'budget-fixture',baseUrl:'http://fixture.invalid',capabilities:{}},requests=[];
 const response=await requestWithEffort(async(_,options)=>{requests.push(JSON.parse(options.body));return requests.length===1?new Response('max_tokens unsupported',{status:400}):new Response('{}');},p.baseUrl,{},body,p,'synthetic','high',()=>{});
 assert.equal(response.status,200);assert.equal(requests.length,2);assert.equal(requests[1].max_tokens,undefined);
 assert.equal(requests[1].messages[0].content,'Think through this step by step before answering.');
});


test('configured local Qwen uses actual template thinking switches, preserves options and default', async()=>{
 const prior={kind:process.env.MODEL_MANAGER_KIND,url:process.env.INFERENCE_BASE_URL};
 process.env.MODEL_MANAGER_KIND='lemonade';process.env.INFERENCE_BASE_URL='http://synthetic-lemonade/v1';
 try {
  const p={id:'local',baseUrl:process.env.INFERENCE_BASE_URL};
  const b={...body,model:'Qwen3.5-9B-GGUF-UD-Q4_K_XL',chat_template_kwargs:{custom:'keep'}};
  assert.equal(modeFor(p,b.model,'high'),'real');
  assert.deepEqual(requestBody(b,'high','real',p).chat_template_kwargs,{custom:'keep',enable_thinking:true});
  assert.equal(requestBody(b,'low','real',p).chat_template_kwargs.enable_thinking,false);
  assert.equal(requestBody(b,'default','off',p),b);
  assert.equal(modeFor({...p,baseUrl:'http://another-host/v1'},b.model,'high'),'hint');
  assert.equal(modeFor(p,'Gemma-unverified','high'),'hint');
  const sent=[];await requestWithEffort(async(_,opts)=>{sent.push(JSON.parse(opts.body));return new Response('{}');},p.baseUrl,{},b,p,b.model,'low',()=>{});
  assert.equal(sent[0].chat_template_kwargs.enable_thinking,false);assert.equal(sent[0].reasoning_effort,undefined);
 } finally {for(const [key,val] of [['MODEL_MANAGER_KIND',prior.kind],['INFERENCE_BASE_URL',prior.url]]){if(val===undefined)delete process.env[key];else process.env[key]=val;}}
});

test('explicit context budget is never raised or removed by high effort',async()=>{
 const p={id:'budget-test',baseUrl:'https://fixture.invalid'}, requests=[];
 const response=await requestWithEffort(async(_,options)=>{requests.push(JSON.parse(options.body));return new Response('max_tokens unsupported',{status:400});},p.baseUrl,{}, {model:'synthetic',messages:[],max_tokens:2048},p,'synthetic','high',()=>{});
 assert.equal(response.status,400);assert.equal(requests.length,1);assert.equal(requests[0].max_tokens,2048);
});
