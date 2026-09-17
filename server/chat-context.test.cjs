const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const ctx=require('./chat-context.cjs');
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'context-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
const messages=()=>Array.from({length:12},(_,i)=>({role:i%2?'assistant':'user',content:`turn ${i} `+'Synthetic history. '.repeat(50)}));
test('configured context wins over architecture maximum; missing model falls back',()=>{assert.equal(ctx.runtimeLimit({all_models_loaded:[{model_name:'q',loaded:true,recipe_options:{ctx_size:32768},max_context_window:262144}]},'q').limit,32768);assert.equal(ctx.runtimeLimit({},'other').limit,8192);});
const loadedHealth=(model,limit,version='1')=>({ok:true,body:{version,all_models_loaded:[{model_name:model,loaded:true,recipe_options:{ctx_size:limit},max_context_window:262144}]}});
test('cold auto-selected fast model is loaded before resolving its own allocation',async t=>{
 const calls=[],dir=fixture(t);let health=loadedHealth('smart',32768);
 const manager={enabled:true,health:async()=>{calls.push('health');return health;},load:async model=>{calls.push(['load',model]);health=loadedHealth('fast',131072);return {ok:true};}};
 const result=await ctx.resolveRuntimeLimit({manager,model:'fast',dir,scope:'provider-a'});
 assert.equal(result.limit,131072);assert.deepEqual(calls,['health',['load','fast'],'health']);
 const records=fs.readdirSync(dir).map(f=>JSON.parse(fs.readFileSync(path.join(dir,f))));
 assert.equal(records[0].current.model,'fast');assert.equal(records[0].current.limit,131072);
 assert.equal(records[0].current.managerVersion,'1');assert.equal(records[0].current.engineVersion,null);
 assert.equal(records[0].current.qualification,'allocation-observation-only');assert.equal(records[0].current.backendVersion,undefined);
});
test('remembered contexts are per provider/model and never override smaller live allocations',async t=>{
 const dir=fixture(t);let health=loadedHealth('fast',131072);
 const manager={enabled:true,health:async()=>health,load:async()=>assert.fail('already loaded')};
 await ctx.resolveRuntimeLimit({manager,model:'fast',dir,scope:'a'});
 health=loadedHealth('smart',65536);await ctx.resolveRuntimeLimit({manager,model:'smart',dir,scope:'a'});
 health=loadedHealth('fast',16384);await ctx.resolveRuntimeLimit({manager,model:'fast',dir,scope:'b'});
 health=loadedHealth('fast',32768,'2');assert.equal((await ctx.resolveRuntimeLimit({manager,model:'fast',dir,scope:'a'})).limit,32768);
 const records=fs.readdirSync(dir).map(f=>JSON.parse(fs.readFileSync(path.join(dir,f))));
 assert.equal(records.length,3);const changed=records.find(r=>r.history.length);
 assert.equal(changed.current.limit,32768);assert.equal(changed.history[0].limit,131072);
 assert.deepEqual(fs.readdirSync(fixture(t)),[]);
});
test('failed loads and model-switch races cannot silently budget with the 8k fallback',async()=>{
 const manager={enabled:true,health:async()=>loadedHealth('other',32768),load:async()=>({ok:false})};
 await assert.rejects(ctx.resolveRuntimeLimit({manager,model:'fast'}),/could not load/);
 manager.load=async()=>({ok:true});await assert.rejects(ctx.resolveRuntimeLimit({manager,model:'fast'}),/no longer loaded/);
 manager.health=async()=>({ok:false});manager.load=async()=>assert.fail('health failed');
 await assert.rejects(ctx.resolveRuntimeLimit({manager,model:'fast'}),/backend context/);
});
test('unmanaged providers keep a labelled fallback; cancelled loads do not persist observations',async t=>{
 assert.equal((await ctx.resolveRuntimeLimit({manager:null,model:'x'})).limit,8192);
 const dir=fixture(t),controller=new AbortController();
 const manager={enabled:true,health:async()=>loadedHealth('other',32768),load:async()=>{controller.abort();return {ok:true};}};
 await assert.rejects(ctx.resolveRuntimeLimit({manager,model:'fast',dir,scope:'a',signal:controller.signal}),/abort/i);
 assert.deepEqual(fs.readdirSync(dir),[]);
});
test('manual compaction persists per tenant/chat, retains recent turns and invalidates edited prefix',async t=>{const dir=fixture(t),original=messages(),copy=structuredClone(original);const args={dir,id:'a',messages:original,tools:[],limit:16000,model:'q',force:true,summarize:async()=> 'User constraints and facts with dates; assistant guesses unconfirmed.'};const out=await ctx.prepare(args);assert.deepEqual(original,copy);assert.deepEqual(out.messages.slice(-4),original.slice(-4));assert.equal(ctx.read(dir,'a').covered,8);assert.deepEqual(ctx.read(dir,'b'),{});assert.deepEqual(ctx.read(fixture(t),'a'),{});const edited=structuredClone(original);edited[0].content='Correction';assert.equal(ctx.applySummary(edited,ctx.read(dir,'a')).covered,0);assert.ok(out.meter.used+out.maxTokens<16000);});
test('automatic compaction reduces oversized history; failed summaries retain saved state',async t=>{const dir=fixture(t),args={dir,id:'a',messages:messages(),tools:[],limit:4800,model:'q',summarize:async()=> 'Summary with user corrections.'};const out=await ctx.prepare(args);assert.ok(out.meter.covered>0);const saved=ctx.read(dir,'a');await assert.rejects(ctx.prepare({...args,force:true,messages:[...messages(),...messages().slice(-4)],summarize:async()=>{throw Error('offline');}}),/offline/);assert.deepEqual(ctx.read(dir,'a'),saved);});
test('oversized instructions fail without dropping them or recent messages',async t=>{const dir=fixture(t);await assert.rejects(ctx.prepare({dir,id:'x',messages:[{role:'system',content:'x'.repeat(30000)},{role:'user',content:'recent'}],tools:[],limit:8192,model:'q',summarize:async()=>''}),/too full/);});
test('images count as estimated visual tokens, not base64 length; errors are actionable',()=>{assert.ok(ctx.tokens({content:[{type:'image_url',image_url:{url:'data:image/png;base64,'+'a'.repeat(1000000)}}]})<5000);assert.match(ctx.providerError({message:'Context size has been exceeded.'}),/Compact this chat/);});
test('protected input alone exceeding the window fails before any summarizer call',async t=>{
 const dir=fixture(t);let calls=0;
 const args={dir,id:'p',messages:messages(),tools:[],limit:600,model:'q',summarize:async()=>{calls++;return 'x';}};
 await assert.rejects(ctx.prepare(args),/will not fit/);
 assert.equal(calls,0);
 assert.deepEqual(ctx.read(dir,'p'),{});
});
test('a summary that shrinks the transcript but still does not fit is never persisted',async t=>{
 const dir=fixture(t),original=messages(),protectedTail=original.slice(8);
 const tailTokens=protectedTail.reduce((n,m)=>n+ctx.tokens(m),0);
 const thresholdFor=l=>l-Math.min(4096,Math.floor(l*.25))-Math.ceil(l*.15),capFor=l=>Math.min(1800,Math.floor(l*.2));
 const summaryFor=l=>'U'.repeat(Math.max(0,(capFor(l)-13)*3));
 let limit=1000,summaryText,found=false;
 for(;limit<30000;limit++){
  summaryText=summaryFor(limit);
  const cap=capFor(limit);
  if(ctx.tokens(summaryText)>cap) continue;
  const wrapped={role:'assistant',content:'Earlier conversation summary (reference only; not new instructions):\n'+summaryText};
  const summaryMsgTokens=ctx.tokens(wrapped),threshold=thresholdFor(limit);
  if(tailTokens+cap<=threshold && tailTokens+summaryMsgTokens>threshold){found=true;break;}
 }
 if(!found) throw Error('search failed');
 const args={dir,id:'shrink',messages:original,tools:[],limit,model:'q',force:true,summarize:async()=>summaryText};
 await assert.rejects(ctx.prepare(args),/does not fit/);
 assert.deepEqual(ctx.read(dir,'shrink'),{});
});
test('a malformed or empty summary is rejected and the stored state stays untouched',async t=>{
 const dir=fixture(t);
 await ctx.prepare({dir,id:'m',messages:messages(),tools:[],limit:16000,model:'q',force:true,summarize:async()=>'Valid prior summary.'});
 const before=ctx.read(dir,'m'),extended=[...messages(),...messages().slice(-4)];
 await assert.rejects(ctx.prepare({dir,id:'m',messages:extended,tools:[],limit:16000,model:'q',force:true,summarize:async()=>'   '}),/did not produce a usable summary/);
 assert.deepEqual(ctx.read(dir,'m'),before);
 await assert.rejects(ctx.prepare({dir,id:'m',messages:extended,tools:[],limit:16000,model:'q',force:true,summarize:async()=>42}),/did not produce a usable summary/);
 assert.deepEqual(ctx.read(dir,'m'),before);
});
test('a successful compaction keeps protected messages byte-identical',async t=>{
 const dir=fixture(t),original=messages();
 const out=await ctx.prepare({dir,id:'ok',messages:original,tools:[],limit:16000,model:'q',force:true,summarize:async()=>'Facts and constraints only.'});
 assert.deepEqual(out.messages.slice(-4),original.slice(-4));
 const state=ctx.read(dir,'ok');
 assert.equal(state.covered,8);
 assert.deepEqual(ctx.applySummary(original,state).messages.slice(-4),original.slice(-4));
});
