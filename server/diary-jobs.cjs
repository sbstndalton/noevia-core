'use strict';
const fs=require('node:fs'),path=require('node:path');
const {atomicJson}=require('./workspace.cjs');
const active=new Set();
const validDay=day=>typeof day==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(day)&&Number.isFinite(Date.parse(day+'T12:00:00Z'))&&new Date(day+'T12:00:00Z').toISOString().slice(0,10)===day;
function location(workspace,day,id){
 if(!validDay(day)||!/^[a-zA-Z0-9-]{16,80}$/.test(id||''))throw Object.assign(Error('Valid diary day and exchange ID required.'),{status:400});
 return path.join(workspace.dir,'diary-conversations',day,id+'.json');
}
function start(workspace,{entryDay,exchangeId,message,kind,preparationId}){
 const file=location(workspace,entryDay,exchangeId);
 if(fs.existsSync(file))throw Object.assign(Error('This exchange was already submitted. Recover its status before sending again.'),{status:409});
 if(preparationId){
  const prior=JSON.parse(fs.readFileSync(location(workspace,entryDay,preparationId),'utf8'));
  if(prior.kind!=='preparation'||prior.state!=='complete'||prior.message!==message)throw Object.assign(Error('Optional preparation is not complete for this message.'),{status:409});
 }
 const row={kind:kind==='preparation'?'preparation':'capture',preparationId:preparationId||null,tools:[],id:exchangeId,day:entryDay,message,startedAt:Date.now(),state:'running',content:'',reasoning:'',activity:[],decision:null};
 // Persist before dispatch. An orphaned running record is never replayed.
 atomicJson(file,row);active.add(file);
 const save=()=>atomicJson(file,row);
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
   if(event.type==='error'){row.state='uncertain';row.error='The connection or save was interrupted. Check the saved diary before sending again.';}
   if(event.type==='done'){row.state=(row.kind==='preparation'||row.decision&&row.decision!=='error')&&row.state!=='uncertain'?'complete':'uncertain';}
   row.updatedAt=Date.now();save();
  },
  finish(){try{if(row.state==='running'){row.state='uncertain';save();}}finally{active.delete(file);}},
 };
}
function list(workspace,day){
 if(!validDay(day))throw Object.assign(Error('Valid diary day required.'),{status:400});
 const dir=path.join(workspace.dir,'diary-conversations',day);if(!fs.existsSync(dir))return [];
 const names=fs.readdirSync(dir).filter(n=>/^[a-zA-Z0-9-]{16,80}\.json$/.test(n));
 // Bound returned data, without deleting older transcripts.
 return names.map(name=>{
  const file=path.join(dir,name);try{const row=JSON.parse(fs.readFileSync(file,'utf8'));if(row.state==='running'&&!active.has(file))row.state='uncertain';return row;}catch{return null;}
 }).filter(Boolean).sort((a,b)=>a.startedAt-b.startedAt).slice(-100);
}
module.exports={start,list,validDay};
