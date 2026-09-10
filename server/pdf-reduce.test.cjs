const test=require('node:test'),assert=require('node:assert/strict');
const {prepare,INPUT_CAP}=require('./pdf-reduce.cjs');
const large=Buffer.alloc(25*1024*1024+1);large.write('%PDF-1.7');
test('small uploads bypass reduction; non-PDF and oversized input remain bounded',async()=>{
 const b=Buffer.from('hello');assert.equal((await prepare('a.txt',b)).bytes,b);
 await assert.rejects(prepare('a.txt',large),/25 MB/);
 await assert.rejects(prepare('a.pdf',Buffer.alloc(INPUT_CAP+1)),/60 MB/);
 await assert.rejects(prepare('a.pdf',Buffer.alloc(large.length)),/not a PDF/);
});
test('compression and text fallback use explicit derivative names and notices',async()=>{
 const stages=[];const opts={url:'http://worker',progress:s=>stages.push(s),fetchImpl:async(url,o)=>{assert.equal(url,'http://worker/reduce-pdf');assert.equal(o.body,large);return Response.json({kind:'pdf',dataBase64:Buffer.from('%PDF-1.7 reduced').toString('base64')});}};
 const compressed=await prepare('report.pdf',large,opts);assert.equal(compressed.name,'report.compressed.pdf');assert.equal(compressed.reduction.originalBytes,large.length);assert.match(stages[0],/compressing/);
 const text=await prepare('report.pdf',large,{...opts,fetchImpl:async()=>Response.json({kind:'text',text:'Synthetic extracted text'})});
 assert.equal(text.name,'report.extracted.txt');assert.match(text.reduction.note,/omitted/);
});
test('unavailable, busy, failed and invalid workers never create an accepted source',async()=>{
 await assert.rejects(prepare('a.pdf',large,{url:''}),/unavailable/);
 for(const status of [503,422])await assert.rejects(prepare('a.pdf',large,{url:'http://worker',fetchImpl:async()=>new Response('',{status})}));
 await assert.rejects(prepare('a.pdf',large,{url:'http://worker',fetchImpl:async()=>Response.json({kind:'pdf',dataBase64:'bad'})}),/Invalid/);
});
