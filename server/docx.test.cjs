const test=require('node:test'),assert=require('node:assert/strict');
const {extract}=require('./docx.cjs');
test('DOCX bytes go only to the private configured worker, with redirects rejected',async()=>{
 const bytes=Buffer.from('synthetic');
 const out=await extract(bytes,{url:'http://worker.invalid/',fetchImpl:async(url,options)=>{
  assert.equal(url,'http://worker.invalid/extract-docx');assert.equal(options.redirect,'error');assert.equal(options.body,bytes);
  return new Response(JSON.stringify({text:'synthetic',truncated:false}));
 }});assert.equal(out.text,'synthetic');
});
test('DOCX worker failures and malformed responses remain explicit',async()=>{
 await assert.rejects(extract(Buffer.from('x'),{url:''}),/unavailable/);
 await assert.rejects(extract(Buffer.from('x'),{url:'http://fixture.invalid',fetchImpl:async()=>new Response('{}',{status:503})}),/busy/);
 await assert.rejects(extract(Buffer.from('x'),{url:'http://fixture.invalid',fetchImpl:async()=>new Response('{}')}),/Invalid/);
});
