'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const jobs=require('./diary-jobs.cjs'),{proxyDiaryStream}=require('./diary-stream.cjs');
const data={entryDay:'2026-09-12',exchangeId:'synthetic-exchange-12345',message:'SYNTHETIC diary request'};
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'diary-jobs-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return{dir};}
test('records before dispatch, blocks duplicate IDs, scopes by tenant and day',t=>{
 const w=fixture(t),other=fixture(t),j=jobs.start(w,data);
 assert.equal(jobs.list(w,data.entryDay)[0].state,'running');assert.deepEqual(jobs.list(other,data.entryDay),[]);
 assert.throws(()=>jobs.start(w,data),e=>e.status===409);assert.throws(()=>jobs.start(w,{...data,exchangeId:'../../x'}),e=>e.status===400);
 assert.equal(jobs.validDay('2026-99-99'),false);
 j.event({type:'answer',text:'Synthetic answer'});j.event({type:'diary',decision:'logged'});j.event({type:'done'});j.finish();
 assert.equal(jobs.list(w,data.entryDay)[0].state,'complete');
});
test('missing completion, saving errors and orphaned running files recover as uncertain',t=>{
 const w=fixture(t),j=jobs.start(w,data);j.event({type:'answer',text:'Answer without save acknowledgement'});j.finish();assert.equal(jobs.list(w,data.entryDay)[0].state,'uncertain');
 const file=path.join(w.dir,'diary-conversations',data.entryDay,data.exchangeId+'.json');const row=JSON.parse(fs.readFileSync(file));row.state='running';fs.writeFileSync(file,JSON.stringify(row));assert.equal(jobs.list(w,data.entryDay)[0].state,'uncertain');
});
test('continues collecting a single synthetic exchange after browser disconnect',async t=>{
 const w=fixture(t);let calls=0,release;const gate=new Promise(r=>release=r);
 const upstream=http.createServer(async(req,res)=>{calls++;res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: {"type":"status","text":"Synthetic processing"}\n\n');await gate;res.end('data: {"type":"answer","text":"RECOVERED-ANSWER"}\n\ndata: {"type":"diary","decision":"logged"}\n\ndata: {"type":"done"}\n\n');});
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r));t.after(()=>upstream.close());
 let complete;const done=new Promise(r=>complete=r);
 const proxy=http.createServer(async(req,res)=>{await proxyDiaryStream(res,`http://127.0.0.1:${upstream.address().port}`,{}, {job:jobs.start(w,data),heartbeatMs:50});complete();});
 await new Promise(r=>proxy.listen(0,'127.0.0.1',r));t.after(()=>proxy.close());
 const controller=new AbortController();const response=await fetch(`http://127.0.0.1:${proxy.address().port}`,{signal:controller.signal});await response.body.getReader().read();controller.abort();
 release();await done;const [row]=jobs.list(w,data.entryDay);assert.equal(row.content,'RECOVERED-ANSWER');assert.equal(row.state,'complete');assert.equal(calls,1);
});
test('optional preparation survives interruption without retaining approval actions',t=>{
 const w=fixture(t),j=jobs.start(w,{...data,kind:'preparation'});
 j.event({type:'tool_pending',index:0,name:'synthetic_write',args:'{"text":"fixture"}',id:'live-approval-secret'});j.finish();
 const [row]=jobs.list(w,data.entryDay);assert.equal(row.kind,'preparation');assert.equal(row.state,'uncertain');
 assert.equal(row.tools[0].status,'denied');assert.equal(JSON.stringify(row).includes('live-approval-secret'),false);
 assert.throws(()=>jobs.start(w,{...data,exchangeId:'capture-synthetic-12345',preparationId:data.exchangeId}),e=>e.status===409);
});
test('completed preparation links only within its tenant, day and matching message',t=>{
 const w=fixture(t),j=jobs.start(w,{...data,kind:'preparation'});
 j.event({type:'tool_result',index:0,name:'synthetic_read',text:'Synthetic result'});j.event({type:'done'});j.finish();
 assert.equal(jobs.list(w,data.entryDay)[0].state,'complete');
 assert.throws(()=>jobs.start(w,{...data,exchangeId:'capture-synthetic-12345',preparationId:data.exchangeId,message:'different'}),e=>e.status===409);
 assert.throws(()=>jobs.start(fixture(t),{...data,exchangeId:'capture-synthetic-12345',preparationId:data.exchangeId}));
 const capture=jobs.start(w,{...data,exchangeId:'capture-synthetic-12345',preparationId:data.exchangeId});capture.finish();
 assert.equal(jobs.list(w,data.entryDay).find(row=>row.id==='capture-synthetic-12345').preparationId,data.exchangeId);
});
test('preparation history is bounded and explicitly marks truncated results',t=>{
 const w=fixture(t),j=jobs.start(w,{...data,kind:'preparation'});
 for(let index=0;index<96;index++)j.event({type:'tool_result',index,name:'synthetic',text:'x'.repeat(20000)});
 j.finish();const [row]=jobs.list(w,data.entryDay);assert.equal(row.truncated,true);assert.ok(row.tools.reduce((n,t)=>n+t.args.length,0)<=64000);
});
test('#874 streamed deltas are written at most every interval; decisions, done and finish write at once',t=>{
 const w=fixture(t);
 let clock=1000;const timers=[];
 const j=jobs.start(w,data,{saveIntervalMs:500,now:()=>clock,setTimer:(fn,ms)=>{const timer={fn,ms,unref(){}};timers.push(timer);return timer;},clearTimer:timer=>{const i=timers.indexOf(timer);if(i>=0)timers.splice(i,1);}});
 const file=path.join(w.dir,'diary-conversations',data.entryDay,data.exchangeId+'.json');
 const onDisk=()=>JSON.parse(fs.readFileSync(file,'utf8'));
 let writes=0;const original=fs.renameSync;fs.renameSync=(...args)=>{if(String(args[1])===file)writes++;return original(...args);};t.after(()=>{fs.renameSync=original;});
 for(let i=0;i<1000;i++)j.event({type:'delta',text:'x'});
 assert.equal(writes,0,'1000 deltas inside one interval write nothing yet');
 assert.equal(timers.length,1,'one trailing write is scheduled');assert.equal(timers[0].ms,500);
 timers.shift().fn();
 assert.equal(writes,1);assert.equal(onDisk().content.length,1000);
 clock+=499;j.event({type:'delta',text:'y'});assert.equal(writes,1);
 clock+=1;j.event({type:'delta',text:'z'});assert.equal(writes,2,'an interval has passed: written');
 j.event({type:'delta',text:'w'});assert.equal(writes,2);
 j.event({type:'diary',decision:'logged'});assert.equal(writes,3,'a decision is written at once');
 assert.equal(onDisk().content,'x'.repeat(1000)+'yzw');assert.equal(timers.length,0,'nothing left pending');
 j.event({type:'delta',text:'!'});j.event({type:'done'});assert.equal(writes,4);assert.equal(onDisk().state,'complete');
 j.event({type:'reasoning',text:'tail'});j.finish();
 assert.equal(writes,5,'finish flushes a pending write');assert.equal(onDisk().reasoning,'tail');assert.equal(timers.length,0);
 assert.equal(jobs.list(w,data.entryDay)[0].state,'complete');
});
test('#874 a failed throttled write is retried by finish()',t=>{
 const w=fixture(t);let clock=1000;const timers=[];
 const j=jobs.start(w,data,{saveIntervalMs:500,now:()=>clock,setTimer:fn=>{const timer={fn,unref(){}};timers.push(timer);return timer;},clearTimer:timer=>{const i=timers.indexOf(timer);if(i>=0)timers.splice(i,1);}});
 const file=path.join(w.dir,'diary-conversations',data.entryDay,data.exchangeId+'.json');
 j.event({type:'delta',text:'kept '});j.event({type:'diary',decision:'logged'});j.event({type:'done'});
 // A late text event after done: only the throttled path can write it.
 j.event({type:'delta',text:'text'});
 const original=fs.renameSync;let fail=true;fs.renameSync=(...args)=>{if(fail&&String(args[1])===file)throw Object.assign(Error('disk full'),{code:'ENOSPC'});return original(...args);};t.after(()=>{fs.renameSync=original;});
 timers.shift().fn();
 assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).content,'kept ','the timer write failed');
 fail=false;clock+=10;j.finish();
 const row=JSON.parse(fs.readFileSync(file,'utf8'));assert.equal(row.content,'kept text');assert.equal(row.state,'complete');
});
test('#894 a failed immediate write (done) is retried by finish()',t=>{
 const w=fixture(t);
 const j=jobs.start(w,data,{saveIntervalMs:500,now:()=>1000,setTimer:()=>({unref(){}}),clearTimer:()=>{}});
 const file=path.join(w.dir,'diary-conversations',data.entryDay,data.exchangeId+'.json');
 j.event({type:'diary',decision:'logged'});
 const original=fs.renameSync;let fail=true;fs.renameSync=(...args)=>{if(fail&&String(args[1])===file)throw Object.assign(Error('disk full'),{code:'ENOSPC'});return original(...args);};t.after(()=>{fs.renameSync=original;});
 assert.throws(()=>j.event({type:'done'}),/disk full/);
 assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).state,'running','the done write failed');
 fail=false;j.finish();
 assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).state,'complete','finish() retried the failed write');
 assert.equal(jobs.list(w,data.entryDay)[0].state,'complete');
});
test('#1422 an error that proves nothing was saved is failed, not uncertain; a later done cannot complete it', t=>{
 const w=fixture(t),j=jobs.start(w,data);
 j.event({type:'error',saved:false,code:'modelFailed',text:"Couldn't reach the local model — nothing was saved. You can resend."});j.event({type:'done'});j.finish();
 const [row]=jobs.list(w,data.entryDay);assert.equal(row.state,'failed');assert.equal(row.code,'modelFailed');assert.match(row.error,/nothing was saved/);
});
test('#1422 an exchange can be marked reviewed once; only uncertain or failed ones, never a running or complete one',t=>{
 const w=fixture(t),j=jobs.start(w,data);
 assert.throws(()=>jobs.acknowledge(w,data.entryDay,data.exchangeId),e=>e.status===409,'still running in this process');
 j.event({type:'error',text:'The connection dropped'});j.finish();
 let at=1000;const row=jobs.acknowledge(w,data.entryDay,data.exchangeId,{now:()=>at});
 assert.equal(row.state,'uncertain');assert.equal(row.acknowledgedAt,1000);
 at=2000;assert.equal(jobs.acknowledge(w,data.entryDay,data.exchangeId,{now:()=>at}).acknowledgedAt,1000,'idempotent');
 assert.equal(jobs.list(w,data.entryDay)[0].acknowledgedAt,1000);assert.equal(jobs.list(w,data.entryDay)[0].state,'uncertain','the outcome itself is never rewritten');
 const done=jobs.start(w,{...data,exchangeId:'complete-exchange-12345'});done.event({type:'diary',decision:'logged'});done.event({type:'done'});done.finish();
 assert.throws(()=>jobs.acknowledge(w,data.entryDay,'complete-exchange-12345'),e=>e.status===409);
 assert.throws(()=>jobs.acknowledge(w,data.entryDay,'missing-exchange-123456'),e=>e.status===404);
 assert.throws(()=>jobs.acknowledge(w,data.entryDay,'../../x'),e=>e.status===400);
 assert.throws(()=>jobs.acknowledge(fixture(t),data.entryDay,data.exchangeId),e=>e.status===404,'another tenant has no such exchange');
});
test('#1422 an orphaned running record (written by an earlier process) can be marked reviewed and reads as uncertain',t=>{
 // A record still `running` on disk that this process never started: the old process died.
 const w=fixture(t),orphan=path.join(w.dir,'diary-conversations',data.entryDay);fs.mkdirSync(orphan,{recursive:true});
 fs.writeFileSync(path.join(orphan,data.exchangeId+'.json'),JSON.stringify({kind:'capture',tools:[],id:data.exchangeId,day:data.entryDay,message:'Synthetic',startedAt:1,state:'running',content:'',reasoning:'',activity:[],decision:null}));
 const other=w;assert.equal(jobs.list(other,data.entryDay)[0].state,'uncertain');
 assert.equal(jobs.acknowledge(other,data.entryDay,data.exchangeId).state,'uncertain');
});

test('#230 a failed row keeps the reason token next to the code; a non-string or over-long one is never stored',t=>{
 const failedRow=event=>{const w=fixture(t),j=jobs.start(w,data);j.event({type:'error',saved:false,text:'Nothing was saved.',...event});j.finish();return jobs.list(w,data.entryDay)[0];};
 for(const reason of ['chat_timeout','length_cap']){
  const row=failedRow({code:'modelFailed',reason});
  assert.equal(row.state,'failed');assert.equal(row.code,'modelFailed');assert.equal(row.reason,reason);
 }
 assert.equal('reason' in failedRow({code:'modelFailed',reason:'z'.repeat(1000)}),false,'dropped, not cut to 40');
 assert.equal('reason' in failedRow({code:'modelFailed',reason:'z'.repeat(41)}),false);
 assert.equal(failedRow({code:'modelFailed',reason:'z'.repeat(40)}).reason,'z'.repeat(40));
 for(const reason of [42,null,true,{nested:'chat_timeout'},['length_cap']]){
  const row=failedRow({code:'modelFailed',reason});assert.equal('reason' in row,false,JSON.stringify(reason));
 }
 assert.equal('reason' in failedRow({code:'modelFailed'}),false);
});
test('#230 the stream records the reason on the recovered row, and an older record without one still loads',async t=>{
 const w=fixture(t);
 const upstream=new Response(new ReadableStream({start(c){for(const e of [{type:'status',text:'Opening diary context…'},{type:'status',text:'Generating companion response…'},{type:'error',code:'modelFailed',reason:'chat_timeout',text:'x'}])c.enqueue(new TextEncoder().encode('data: '+JSON.stringify(e)+'\n\n'));c.close();}}),{headers:{'Content-Type':'text/event-stream'}});
 t.mock.method(globalThis,'fetch',async()=>upstream);
 const res=Object.assign(new (require('node:events'))(),{writeHead(){},write(){return true;},end(){},destroyed:false,writableEnded:false});
 await proxyDiaryStream(res,'http://synthetic',{}, {job:jobs.start(w,data)});
 const [row]=jobs.list(w,data.entryDay);
 assert.equal(row.state,'failed');assert.equal(row.code,'modelFailed');assert.equal(row.reason,'chat_timeout');
 // An older record (written before this field existed) loads as it did, and can still be marked reviewed.
 const file=path.join(w.dir,'diary-conversations',data.entryDay,data.exchangeId+'.json');const old=JSON.parse(fs.readFileSync(file));delete old.reason;fs.writeFileSync(file,JSON.stringify(old));
 const [legacy]=jobs.list(w,data.entryDay);assert.equal(legacy.code,'modelFailed');assert.equal('reason' in legacy,false);
 assert.equal(jobs.acknowledge(w,data.entryDay,data.exchangeId).state,'failed');
});
// #232: the row writer applies the same rule as the live stream, for any direct caller of job.event.
test('#232 a row keeps a reason only for modelFailed and only as a token',t=>{
 const failedRow=event=>{const w=fixture(t),j=jobs.start(w,data);j.event({type:'error',saved:false,text:'Nothing was saved.',...event});j.finish();return jobs.list(w,data.entryDay)[0];};
 for(const code of ['contextFailed','modelNotServed','diaryUnavailable',undefined]){
  const row=failedRow({code,reason:'chat_timeout'});
  assert.equal(row.state,'failed');assert.equal(row.code,code);assert.equal('reason' in row,false,String(code));
 }
 for(const reason of ['chat\ntimeout','chat_timeout\n','chat\u0000timeout','‮schat_timeout','chat⁦timeout','chat timeout','chat-timeout','']){
  const row=failedRow({code:'modelFailed',reason});
  assert.equal(row.state,'failed');assert.equal(row.code,'modelFailed');assert.equal('reason' in row,false,JSON.stringify(reason));
 }
 for(const reason of ['some_new_code','empty_answer','chat_timeout','length_cap'])assert.equal(failedRow({code:'modelFailed',reason}).reason,reason);
});
test('#232 a verbatim contextFailed event through the proxy leaves no reason on the stored row',async t=>{
 const w=fixture(t);
 const upstream=new Response(new ReadableStream({start(c){for(const e of [{type:'status',text:'Opening diary context…'},{type:'error',code:'contextFailed',saved:false,reason:'chat_timeout',text:'x'}])c.enqueue(new TextEncoder().encode('data: '+JSON.stringify(e)+'\n\n'));c.close();}}),{headers:{'Content-Type':'text/event-stream'}});
 t.mock.method(globalThis,'fetch',async()=>upstream);
 const written=[];
 const res=Object.assign(new (require('node:events'))(),{writeHead(){},write(chunk){written.push(String(chunk));return true;},end(){},destroyed:false,writableEnded:false});
 await proxyDiaryStream(res,'http://synthetic',{}, {job:jobs.start(w,data)});
 const browser=written.join('').split('\n\n').filter(f=>f.startsWith('data: ')).map(f=>JSON.parse(f.slice(6))).find(e=>e.type==='error');
 assert.equal(browser.code,'contextFailed');assert.equal(browser.saved,false);assert.equal('reason' in browser,false);
 const [row]=jobs.list(w,data.entryDay);
 assert.equal(row.state,'failed');assert.equal(row.code,'contextFailed');assert.equal('reason' in row,false);
});
test('#234 a failed row keeps a known code as sent and drops, never cuts, anything that is not a token',t=>{
 const failedRow=event=>{const w=fixture(t),j=jobs.start(w,data);j.event({type:'error',saved:false,text:'Nothing was saved.',...event});j.finish();return jobs.list(w,data.entryDay)[0];};
 for(const code of ['modelFailed','storageLoginRejected','x'.repeat(40)])assert.equal(failedRow({code}).code,code);
 const bad=['x'.repeat(41),'x'.repeat(1000),'model failed','model\nFailed','model"Failed','model\u0000Failed','modèl','‮model','',42,null,true,{a:1},['modelFailed'],undefined];
 for(const code of bad){const row=failedRow({code});assert.equal(row.state,'failed',JSON.stringify(code));assert.equal('code' in row,false,JSON.stringify(code));}
 assert.equal('code' in failedRow({}),false);
});
