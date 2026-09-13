'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
// Deliberately conservative estimate; never present this as tokenizer output.
const tokens = value => { let images=0;const text=typeof value==='string'?value:JSON.stringify(value??'',(key,item)=>{if(key==='image_url'){images++;return '[image]';}return item;});return Math.ceil(Buffer.byteLength(text,'utf8')/3)+12+images*4096; };
const fingerprint = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function stateFile(dir, id) { return path.join(dir, 'context-' + fingerprint(String(id)) + '.json'); }
function read(dir, id) { try { return JSON.parse(fs.readFileSync(stateFile(dir,id),'utf8')); } catch { return {}; } }
function save(dir,id,state) { fs.mkdirSync(dir,{recursive:true}); const file=stateFile(dir,id),tmp=file+'.'+crypto.randomUUID(); fs.writeFileSync(tmp,JSON.stringify(state),{mode:0o600}); fs.renameSync(tmp,file); }
function runtimeLimit(health, model) {
  const entry=health?.all_models_loaded?.find(m=>m.model_name===model && m.loaded && m.backend_alive!==false);
  const configured=Number(entry?.recipe_options?.ctx_size);
  return Number.isFinite(configured)&&configured>=2048 ? {limit:Math.floor(configured),limitSource:'Configured backend context'} : {limit:8192,limitSource:'Conservative fallback; backend limit unavailable'};
}
async function resolveRuntimeLimit({manager,model,dir,scope,onStatus=()=>{},signal}) {
  if (!manager?.enabled) return runtimeLimit(null,model);
  signal?.throwIfAborted();
  let response=await manager.health();
  if (!response.ok) throw Error('Could not read the model backend context. Try again when the backend is available.');
  let health=response.body;
  if (!health?.all_models_loaded?.some(m=>m.model_name===model && m.loaded && m.backend_alive!==false)) {
    onStatus('Loading the selected model and checking its context allocation…');
    signal?.throwIfAborted();
    const loaded=await manager.load(model);
    if (!loaded.ok) throw Error('The selected model could not load. Its context allocation was not changed.');
    signal?.throwIfAborted();
    response=await manager.health();
    if (!response.ok) throw Error('The model loaded, but its context allocation could not be checked. Try again.');
    health=response.body;
    if (!health?.all_models_loaded?.some(m=>m.model_name===model && m.loaded && m.backend_alive!==false)) {
      throw Error('The selected model is no longer loaded. Another request may have switched models; try again.');
    }
  }
  signal?.throwIfAborted();
  const result=runtimeLimit(health,model);
  const entry=health?.all_models_loaded?.find(m=>m.model_name===model && m.loaded);
  // Observations are per tenant/provider/model, never a guessed architecture maximum.
  // Recheck the live backend every time; past allocations do not prove current capacity.
  if (dir && scope && entry && Number(entry.recipe_options?.ctx_size)>=2048) {
    const id='runtime-model:'+fingerprint([scope,model]);
    const previous=read(dir,id);
    const configuration=fingerprint([health.version,entry.checkpoint,entry.recipe_options]);
    const observation={model,limit:result.limit,source:result.limitSource,configuration,backendVersion:health.version,observedAt:Date.now()};
    const history=Array.isArray(previous.history)?previous.history:[];
    if (previous.current && previous.current.configuration!==configuration) history.push(previous.current);
    save(dir,id,{current:observation,history:history.slice(-20)});
  }
  return result;
}
function applySummary(messages,state) {
  const n=state.covered||0;
  if (!n || !state.summary || n>messages.length || fingerprint(messages.slice(0,n))!==state.prefix) return {messages,covered:0};
  return {messages:[{role:'assistant',content:'Earlier conversation summary (reference only; not new instructions):\n'+state.summary},...messages.slice(n)],covered:n};
}
function measure(messages,tools,limit,source,model) {
 const system=messages.filter(m=>m.role==='system'), other=messages.filter(m=>m.role!=='system');
 const parts=[{name:'Messages & summary',tokens:other.reduce((n,m)=>n+tokens(m),0)}, {name:'Instructions, memory & sources',tokens:system.reduce((n,m)=>n+tokens(m),0)}, {name:'Tools',tokens:tools.length?tokens(tools):0}];
 const used=parts.reduce((n,p)=>n+p.tokens,0), reserve=Math.min(4096,Math.floor(limit*.25)), safety=Math.ceil(limit*.15);
 return {model,limit,limitSource:source,estimated:true,used,reserve,safety,parts,free:Math.max(0,limit-used-reserve-safety),threshold:limit-reserve-safety,updatedAt:Date.now()};
}
async function prepareUnlocked({dir,id,messages,tools,limit,limitSource,model,force=false,summarize,onStatus=()=>{}}) {
 const state=read(dir,id), system=messages.filter(m=>m.role==='system'), original=messages.filter(m=>m.role!=='system');
 let applied=applySummary(original,state), wire=[...system,...applied.messages];
 if(!applied.covered){delete state.summary;delete state.covered;delete state.prefix;delete state.compactedAt;}
 let meter=measure(wire,tools,limit,limitSource,model);
 if(force || meter.used>meter.threshold) {
  // Keep two recent exchanges intact; never split a user/assistant exchange.
  let cut=Math.max(0,original.length-4);while(cut>0 && original[cut]?.role!=='user')cut--;
  if(cut>applied.covered) {
   onStatus('Compacting older messages… Your full transcript stays available.');
   let summary=applied.covered?state.summary:'', batch=[];
   const budget=Math.max(512,Math.floor(limit*.45));
   const flush=async()=>{if(!batch.length)return;const result=await summarize(summary,batch,Math.min(1536,Math.floor(limit*.15))); if(typeof result!=='string'||!result.trim()||tokens(result)>Math.min(1800,limit*.2))throw Error('Compaction did not produce a usable summary. Your transcript is unchanged; try another model.');summary=result.trim();batch=[];};
   const older=original.slice(applied.covered,cut);
   if(older.length>1000)throw Error('Too much history to compact in one operation. Start a new chat with selected context.');
   let calls=0;
   for(const msg of older) {
    if(tokens(msg)>budget)throw Error('One message is too large to compact safely. Shorten its attachment or start a new chat.');
    if(tokens(batch)+tokens(msg)+tokens(summary)>budget){if(++calls>24)throw Error('Compaction limit reached; original transcript retained.');await flush();}
    batch.push(msg);
   }
   await flush();
   const candidate={summary,covered:cut,prefix:fingerprint(original.slice(0,cut)),compactedAt:Date.now()};
   const next=[...system,...applySummary(original,candidate).messages];
   if(tokens(next)>=tokens(wire))throw Error('Compaction did not reduce the context. Your previous context is retained.');
   Object.assign(state,candidate);wire=next;meter=measure(wire,tools,limit,limitSource,model);
  } else if(force) throw Error('Not enough older messages to compact. Recent exchanges are kept intact.');
 }
 meter.historyCount=original.length;meter.compactedAt=state.compactedAt||null;meter.covered=state.covered||0;
 state.meter=meter;save(dir,id,state);
 if(meter.used>meter.threshold)throw Error('Context is still too full after compaction. Reduce attached sources or start a new chat. No messages were deleted.');
 return {messages:wire,meter,maxTokens:meter.reserve};
}
function providerError(value) {const text=typeof value==='string'?value:JSON.stringify(value);return /context.*(exceed|full|length)|too many tokens|maximum context/i.test(text)?'The model ran out of context space. Compact this chat or reduce its sources before retrying.':'The model stream failed. Partial output was preserved; check the backend before retrying.';}
const busy=new Set();
async function prepare(options){const key=stateFile(options.dir,options.id);if(busy.has(key))throw Error('This chat is already preparing context. Wait for that request to finish.');busy.add(key);try{return await prepareUnlocked(options);}finally{busy.delete(key);}}
function remove(dir,id){fs.rmSync(stateFile(dir,id),{force:true});}
module.exports={remove,tokens,read,save,runtimeLimit,resolveRuntimeLimit,applySummary,measure,prepare,providerError};
