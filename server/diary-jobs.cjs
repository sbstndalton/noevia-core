'use strict';
const fs=require('node:fs'),path=require('node:path');
const {atomicJson}=require('./workspace.cjs');
const {eventReason,relayableToken}=require('./diary-stream.cjs');
const {START_ID}=require('./chat-partial.cjs');
// Which exchanges run in this process, per workspace directory ('<day>/<id>.json'). The Rust front lists
// and dismisses the recovery records (#2206), so what was this process's memory is published beside
// them: `diary-conversations/active.json` = { start, files }, with the container start that wrote it
// (NOEVIA_START_ID), so a set left by a Node that is gone names nothing. The order is the contract: a
// record is added to the set (and the set written) BEFORE its first write, and removed AFTER its last,
// so a record that reads `running` and is missing from a set read afterwards is one nothing runs for.
// The file the front reads (noevia-rs crates/server-diary `exchanges::ACTIVE_FILE`).
const SIGNAL='active.json';
const running=new Map();
function publish(dir){
 atomicJson(path.join(dir,'diary-conversations',SIGNAL),{start:START_ID,files:[...(running.get(dir)||[])].sort()});
}
function release(dir,rel){
 const set=running.get(dir);if(!set)return;
 set.delete(rel);if(!set.size)running.delete(dir);
 // Best effort: a stale name only keeps a finished record from being dismissed until the next publish.
 try{publish(dir);}catch{/* the next start or finish writes the whole set again */}
}
const validDay=day=>typeof day==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(day)&&Number.isFinite(Date.parse(day+'T12:00:00Z'))&&new Date(day+'T12:00:00Z').toISOString().slice(0,10)===day;
function location(workspace,day,id){
 if(!validDay(day)||!/^[a-zA-Z0-9-]{16,80}$/.test(id||''))throw Object.assign(Error('Valid diary day and exchange ID required.'),{status:400});
 return path.join(workspace.dir,'diary-conversations',day,id+'.json');
}
// #874: streamed text arrives as many small deltas; rewriting the whole record for each one is
// quadratic in the reply length and blocks the event loop. Events that change what a recovery
// decides on (the decision, done, error, tool calls) and finish() write at once; everything else
// (text, reasoning, status) at most every `saveIntervalMs`, with a trailing timer for the last ones.
const IMMEDIATE=new Set(['diary','done','error','tool','tool_pending','tool_result']);
function start(workspace,{entryDay,exchangeId,message,kind,preparationId},{saveIntervalMs=500,now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout}={}){
 const file=location(workspace,entryDay,exchangeId);
 if(fs.existsSync(file))throw Object.assign(Error('This exchange was already submitted. Recover its status before sending again.'),{status:409});
 if(preparationId){
  const prior=JSON.parse(fs.readFileSync(location(workspace,entryDay,preparationId),'utf8'));
  if(prior.kind!=='preparation'||prior.state!=='complete'||prior.message!==message)throw Object.assign(Error('Optional preparation is not complete for this message.'),{status:409});
 }
 const row={kind:kind==='preparation'?'preparation':'capture',preparationId:preparationId||null,tools:[],id:exchangeId,day:entryDay,message,startedAt:Date.now(),state:'running',content:'',reasoning:'',activity:[],decision:null};
 // Publish the set, then persist the record, before dispatch. An orphaned running record is never replayed.
 const dir=workspace.dir,rel=`${entryDay}/${exchangeId}.json`;
 if(!running.has(dir))running.set(dir,new Set());
 running.get(dir).add(rel);
 try{publish(dir);atomicJson(file,row);}catch(error){release(dir,rel);throw error;}
 let lastSave=now(),timer=null,dirty=false;
 // dirty/lastSave change only once the write succeeded, so a failed write is retried by the next
 // event or by finish().
 const save=()=>{if(timer){clearTimer(timer);timer=null;}atomicJson(file,row);dirty=false;lastSave=now();};
 const saveSoon=()=>{
  dirty=true;
  if(now()-lastSave>=saveIntervalMs)return save();
  if(!timer){timer=setTimer(()=>{timer=null;if(dirty)try{save();}catch{/* the next event or finish() retries */}},Math.max(0,saveIntervalMs-(now()-lastSave)));timer?.unref?.();}
 };
 const append=(field,text)=>{if(typeof text!=='string')return;const value=row[field]+text;row.truncated ||= value.length>200000;row[field]=value.slice(0,200000);};
 return {
  event(event){
   if(event.type==='answer'){row.content='';append('content',event.text);}
   if(event.type==='delta')append('content',event.text);
   if(event.type==='reasoning')append('reasoning',event.text);
   if(event.type==='status'&&typeof event.text==='string'){row.activity.push(event.text.slice(0,1000));row.activity=row.activity.slice(-32);}
   if(row.kind==='preparation'&&['tool','tool_pending','tool_result'].includes(event.type)){
    const i=event.index;
    if(Number.isInteger(i)&&i>=0&&i<96){
     const result=event.type==='tool_result';
     const raw=String((result?event.text:event.args)||'');
     const used=row.tools.reduce((n,t,index)=>n+(index===i?0:(t?.args?.length||0)),0);
     const limit=Math.max(0,Math.min(12000,64000-used-60));
     row.truncated ||= raw.length>limit;
     row.tools[i]={name:String(event.name||'tool').slice(0,200),args:raw.slice(0,limit),status:result?(String(event.text||'').startsWith('ERROR')?'denied':'done'):'denied'};
     // Recovered history never retains an actionable approval ID.
     if(!result)row.tools[i].args+='\n[Interrupted or historical call; do not replay.]';
    }else row.truncated=true;
   }
   if(event.type==='diary'){row.decision=event.decision||null;row.xid=event.xid||null;}
   if(event.type==='error'){
    // #1422: a failure after which the server KNOWS nothing was saved (the proxy proves it from the
    // companion's stage or an HTTP refusal before the exchange started) is `failed`, not `uncertain`:
    // there is nothing to check, the message can simply be resent.
    if(event.saved===false){row.state='failed';row.code=relayableToken(event.code)?event.code:undefined; // #234: the reason rule: a token is kept as sent, anything else is dropped, never cut
    row.reason=eventReason(event);row.error=String(event.text||'Nothing was saved. You can resend.').slice(0,400);}
    else if(row.state!=='failed'){row.state='uncertain';row.error='The connection or save was interrupted. Check the saved diary before sending again.';}
   }
   if(event.type==='done'){row.state=(row.kind==='preparation'||row.decision&&row.decision!=='error')&&row.state!=='uncertain'&&row.state!=='failed'?'complete':row.state==='failed'?'failed':'uncertain';}
   row.updatedAt=Date.now();
   // dirty first: if this write fails, finish() still retries it (#894).
   if(IMMEDIATE.has(event.type)){dirty=true;save();}else saveSoon();
  },
  finish(){try{const interrupted=row.state==='running';if(interrupted)row.state='uncertain';if(interrupted||dirty)save();}finally{if(timer){clearTimer(timer);timer=null;}release(dir,rel);}},
 };
}
module.exports={start,validDay,SIGNAL};
