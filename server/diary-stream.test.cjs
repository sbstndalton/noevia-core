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
