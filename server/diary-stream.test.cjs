const test=require('node:test'),assert=require('node:assert/strict');
const {Writable}=require('node:stream');
const {proxyDiaryStream}=require('./diary-stream.cjs');
function response(){
 const chunks=[];const res=new Writable({write(chunk,_,next){chunks.push(chunk.toString());next();}});
 res.writeHead=(status,headers)=>{res.status=status;res.headers=headers;};
 return {res,text:()=>chunks.join('')};
}
test('Diary sends headers and heartbeat before a slow upstream and relays live reasoning before completion',async t=>{
 let release;const gate=new Promise(r=>release=r);let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;await gate;return new Response(new ReadableStream({start(c){
  c.enqueue(new TextEncoder().encode('data: {"type":"reasoning","text":"Synthetic thought"}\n\n'));
  c.enqueue(new TextEncoder().encode('data: {"type":"done"}\n\n'));c.close();
 }}),{headers:{'Content-Type':'text/event-stream'}});});
 const {res,text}=response();const run=proxyDiaryStream(res,'http://synthetic',{}, {heartbeatMs:5});
 assert.equal(res.status,200);assert.match(text(),/Connecting/);
 await new Promise(r=>setTimeout(r,20));assert.match(text(),/keep-alive/);
 release();await run;assert.match(text(),/Synthetic thought/);assert.equal(calls,1);
});
test('Diary upstream HTML errors are sanitized without retrying the exchange',async t=>{
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response('<html>private proxy detail</html>',{status:524});});
 const {res,text}=response();await proxyDiaryStream(res,'http://synthetic',{});
 assert.match(text(),/may still be saving/);assert.doesNotMatch(text(),/html|private proxy/);assert.equal(calls,1);
});
test('disconnect aborts the transport and does not retry or crash',async t=>{
 let signal,calls=0;t.mock.method(globalThis,'fetch',async(_,opts)=>{calls++;signal=opts.signal;return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('closed'))));});
 const {res}=response();const run=proxyDiaryStream(res,'http://synthetic',{});res.destroy();await run;
 assert.equal(signal.aborted,true);assert.equal(calls,1);
});
test('a non-JSON data frame (e.g. [DONE]) with a job attached does not interrupt the stream',async t=>{
 t.mock.method(globalThis,'fetch',async()=>new Response(new ReadableStream({start(c){
  c.enqueue(new TextEncoder().encode('data: {"type":"reasoning","text":"Synthetic thought"}\n\n'));
  c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
  c.enqueue(new TextEncoder().encode('data: {"type":"done"}\n\n'));c.close();
 }}),{headers:{'Content-Type':'text/event-stream'}}));
 const events=[];const job={event:e=>events.push(e),finish(){}};
 const {res,text}=response();await proxyDiaryStream(res,'http://synthetic',{}, {heartbeatMs:5,job});
 assert.deepEqual(events.map(e=>e.type),['status','reasoning','done']);
 assert.doesNotMatch(text(),/interrupted/);
});
test('heartbeats cannot split a fragmented upstream SSE event',async t=>{
 t.mock.method(globalThis,'fetch',async()=>new Response(new ReadableStream({start(c){
  c.enqueue(new TextEncoder().encode('data: {"type":"reasoning","text":"'));
  setTimeout(()=>{c.enqueue(new TextEncoder().encode('Synthetic"}\n\ndata: {"type":"done"}\n\n'));c.close();},20);
 }}),{headers:{'Content-Type':'text/event-stream'}}));
 const {res,text}=response();await proxyDiaryStream(res,'http://synthetic',{}, {heartbeatMs:5});
 const events=text().split('\n\n').filter(s=>s.startsWith('data: ')).map(s=>JSON.parse(s.slice(6)));
 assert.equal(events.find(e=>e.type==='reasoning').text,'Synthetic');
 assert.match(text(),/keep-alive/);
});
test('#1422 a refusal the companion names before its stream starts is "nothing was saved", with the wait for a throttle', async t => {
 t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({detail:'slow down',code:'storageThrottled',retryAfter:41.2}),{status:503,headers:{'Content-Type':'application/json','Retry-After':'42'}}));
 const events=[];const {res,text}=response();await proxyDiaryStream(res,'http://synthetic',{}, {job:{event:e=>events.push(e),finish(){}}});
 const error=events.find(e=>e.type==='error');
 assert.equal(error.code,'storageThrottled');assert.equal(error.saved,false);assert.equal(error.retryAfter,42);
 assert.match(text(),/nothing was saved/);assert.doesNotMatch(text(),/may still be saving/);
});
test('#1422 no connection at all (refused) means the request never ran; a dropped stream stays unknown', async t => {
 t.mock.method(globalThis,'fetch',async()=>{throw Object.assign(new TypeError('fetch failed'),{cause:Object.assign(new Error('connect ECONNREFUSED'),{code:'ECONNREFUSED'})});});
 let r=response();await proxyDiaryStream(r.res,'http://synthetic',{});
 assert.match(r.text(),/"code":"diaryUnavailable"/);assert.match(r.text(),/nothing was saved/);
 t.mock.restoreAll();
 t.mock.method(globalThis,'fetch',async()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('data: {"type":"status","text":"Generating companion response…"}\n\ndata: {"type":"del'));c.close();}}),{headers:{'Content-Type':'text/event-stream'}}));
 r=response();await proxyDiaryStream(r.res,'http://synthetic',{});
 assert.match(r.text(),/may still be saving/);assert.doesNotMatch(r.text(),/"saved":false/);
});
test('#1422 the companion stage decides: an error before saving began is not saved, once saving began it is unknown', async t => {
 const stream=events=>new Response(new ReadableStream({start(c){for(const e of events)c.enqueue(new TextEncoder().encode('data: '+JSON.stringify(e)+'\n\n'));c.close();}}),{headers:{'Content-Type':'text/event-stream'}});
 const failed={type:'error',text:'Diary processing failed.'};
 for(const [statuses,expected] of [[[],undefined],[['Opening diary context…'],'contextFailed'],[['Opening diary context…','Generating companion response…'],'modelFailed'],[['Opening diary context…','Generating companion response…','Checking whether to save this exchange…'],undefined],[['Opening diary context…','Generating companion response…','A step added by a newer companion…'],undefined]]){
  t.mock.restoreAll();t.mock.method(globalThis,'fetch',async()=>stream([...statuses.map(text=>({type:'status',text})),failed]));
  const events=[];const {res}=response();await proxyDiaryStream(res,'http://synthetic',{}, {job:{event:e=>events.push(e),finish(){}}});
  assert.equal(events.find(e=>e.type==='error').code,expected,statuses.join('|'));
 }
});
// #228: the companion's `reason` (chat_timeout, length_cap) names why the model failed. It is relayed
// unchanged when it is a string; a missing reason stays missing; a non-string reason is not forwarded.
const reasonStream=events=>new Response(new ReadableStream({start(c){for(const e of events)c.enqueue(new TextEncoder().encode('data: '+JSON.stringify(e)+'\n\n'));c.close();}}),{headers:{'Content-Type':'text/event-stream'}});
async function relayed(t,events,options={}){
 t.mock.restoreAll();t.mock.method(globalThis,'fetch',async()=>reasonStream(events));
 const seen=[];const {res,text}=response();await proxyDiaryStream(res,'http://synthetic',{}, {...options,job:{event:e=>seen.push(e),finish(){}}});
 const wire=text().split('\n\n').filter(s=>s.startsWith('data: ')).map(s=>JSON.parse(s.slice(6))).find(e=>e.type==='error');
 return {wire,job:seen.find(e=>e.type==='error')};
}
const GENERATING=[{type:'status',text:'Opening diary context…'},{type:'status',text:'Generating companion response…'}];
test('#228 a saved:false model error keeps its string reason exactly, on the wire and in the recovery record',async t=>{
 for(const reason of ['chat_timeout','length_cap']){
  const error={type:'error',code:'modelFailed',reason,saved:false,text:'Synthetic companion text'};
  const {wire,job}=await relayed(t,[...GENERATING,error]);
  assert.deepEqual(wire,error,reason);assert.deepEqual(job,error,reason);
 }
});
test('#228 a model error the proxy rewords (no saved flag) still carries the companion reason',async t=>{
 for(const reason of ['chat_timeout','length_cap']){
  const {wire,job}=await relayed(t,[...GENERATING,{type:'error',code:'modelFailed',reason,text:'Synthetic companion text'}]);
  for(const e of [wire,job]){assert.equal(e.code,'modelFailed',reason);assert.equal(e.saved,false,reason);assert.equal(e.reason,reason);}
 }
});
test('#228 a missing reason stays missing',async t=>{
 const verbatim=await relayed(t,[...GENERATING,{type:'error',code:'modelFailed',saved:false,text:'Synthetic companion text'}]);
 const reworded=await relayed(t,[...GENERATING,{type:'error',text:'x'}]);
 for(const e of [verbatim.wire,verbatim.job,reworded.wire,reworded.job])assert.equal('reason' in e,false);
 assert.equal(reworded.wire.code,'modelFailed');
});
test('#228 a non-string reason is not forwarded, whether the error is relayed as sent or reworded',async t=>{
 for(const reason of [42,null,true,{nested:'chat_timeout'},['length_cap']]){
  const sent=await relayed(t,[...GENERATING,{type:'error',code:'modelFailed',reason,saved:false,text:'Synthetic companion text'}]);
  const reworded=await relayed(t,[...GENERATING,{type:'error',reason,text:'x'}]);
  for(const e of [sent.wire,sent.job,reworded.wire,reworded.job])assert.equal('reason' in e,false,JSON.stringify(reason));
  assert.equal(sent.wire.code,'modelFailed');assert.equal(sent.wire.saved,false);assert.equal(sent.wire.text,'Synthetic companion text');
 }
});

// #230: the reason belongs to `modelFailed` only, the companion's reason is never overridden by a
// diagnosis field of the same name, and a relayed reason is a short string (dropped, not cut, above 40).
test('#230 the companion reason is attached to modelFailed only, not to contextFailed or a diagnosed code',async t=>{
 const companion={type:'error',reason:'chat_timeout',text:'x'};
 const model=await relayed(t,[...GENERATING,companion]);
 for(const e of [model.wire,model.job]){assert.equal(e.code,'modelFailed');assert.equal(e.reason,'chat_timeout');}
 const context=await relayed(t,[GENERATING[0],companion]);
 for(const e of [context.wire,context.job]){assert.equal(e.code,'contextFailed');assert.equal(e.saved,false);assert.equal('reason' in e,false);}
 const diagnosed=await relayed(t,[...GENERATING,companion],{diagnose:async()=>({code:'modelNotServed',model:'synthetic-model'})});
 for(const e of [diagnosed.wire,diagnosed.job]){assert.equal(e.code,'modelNotServed');assert.equal(e.model,'synthetic-model');assert.equal('reason' in e,false);}
 // A diagnosis that names no known code falls back to modelFailed, which does carry the companion reason.
 const unknown=await relayed(t,[...GENERATING,companion],{diagnose:async()=>({code:'somethingNew'})});
 assert.equal(unknown.wire.code,'modelFailed');assert.equal(unknown.wire.reason,'chat_timeout');
});
test('#230 a diagnosis field named reason never overrides the companion reason',async t=>{
 // Diagnosis answering modelFailed itself: the companion reason wins; with none from the companion, the diagnosis one is not used.
 const win=await relayed(t,[...GENERATING,{type:'error',reason:'length_cap',text:'x'}],{diagnose:async()=>({code:'modelFailed',reason:'diagnosis_reason',detail:'kept'})});
 for(const e of [win.wire,win.job]){assert.equal(e.code,'modelFailed');assert.equal(e.reason,'length_cap');assert.equal(e.detail,'kept');}
 const none=await relayed(t,[...GENERATING,{type:'error',text:'x'}],{diagnose:async()=>({code:'modelFailed',reason:'diagnosis_reason'})});
 assert.equal('reason' in none.wire,false);
 // A different diagnosed code keeps its own fields (including its own reason); the companion reason is not mixed in.
 const other=await relayed(t,[...GENERATING,{type:'error',reason:'length_cap',text:'x'}],{diagnose:async()=>({code:'modelNotServed',reason:'diagnosis_reason'})});
 assert.equal(other.wire.code,'modelNotServed');assert.equal(other.wire.reason,'diagnosis_reason');
});
test('#230 a reason longer than 40 characters is dropped (not truncated); 40 characters and new codes pass',async t=>{
 const long='x'.repeat(1000);
 const sent=await relayed(t,[...GENERATING,{type:'error',code:'modelFailed',reason:long,saved:false,text:'Synthetic companion text'}]);
 const reworded=await relayed(t,[...GENERATING,{type:'error',reason:long,text:'x'}]);
 for(const e of [sent.wire,sent.job,reworded.wire,reworded.job])assert.equal('reason' in e,false);
 assert.equal(sent.wire.code,'modelFailed');assert.equal(sent.wire.text,'Synthetic companion text');assert.equal(reworded.wire.code,'modelFailed');
 assert.ok(!JSON.stringify([sent.wire,reworded.wire]).includes('xxxxxxxxxx'));
 for(const reason of ['a_new_companion_code','y'.repeat(40)]){
  const e=await relayed(t,[...GENERATING,{type:'error',reason,text:'x'}]);
  assert.equal(e.wire.reason,reason);assert.equal(e.job.reason,reason);
  assert.equal((await relayed(t,[...GENERATING,{type:'error',code:'modelFailed',reason,saved:false,text:'x'}])).wire.reason,reason);
 }
 assert.equal('reason' in (await relayed(t,[...GENERATING,{type:'error',reason:'y'.repeat(41),text:'x'}])).wire,false);
});
