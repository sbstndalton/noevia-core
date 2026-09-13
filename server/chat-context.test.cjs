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
