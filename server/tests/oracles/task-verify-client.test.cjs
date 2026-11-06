'use strict';const{test}=require('node:test');const assert=require('node:assert/strict');const{EventEmitter}=require('node:events');const fs=require('node:fs'),path=require('node:path');const{createCodeVerify}=require('../../code-verify.cjs');
test('verifier client records only nonce and commit bound server measurements',async()=>{
 const task='22222222-2222-4222-8222-222222222222',head='a'.repeat(40);const fixtures=[];
 const cases=[{}, {exitCode:1},{signal:'SIGTERM'},{timedOut:true},{badShape:true},{badNonce:true},{badHead:true},{exitCode:'0',signal:'bad-signal',totalBytes:3.5},{tail:'x'.repeat(1200)+'😀'.repeat(280)+'\u0000\u001b\r\nend',totalBytes:4000},{signal:'SIG12345678901'},{exitCode:null,totalBytes:-1}];
 for(const input of cases){const events=[],requests=[];let hangsUp=0;
  const verifier=createCodeVerify({endpoint:'127.0.0.1:1',tailBytes:1024,now:()=>1234,nonceFn:()=> 'n'.repeat(32),connectRetryMs:0,connectFn:()=>{
   const socket=new EventEmitter();socket.destroy=()=>{hangsUp++;};socket.write=line=>{const request=JSON.parse(line);requests.push(request);queueMicrotask(()=>{socket.emit('connect');const answer={noevia:'verify-result',nonce:request.nonce,ok:true,headSha:head,exitCode:0,signal:null,timedOut:false,tail:'ok\n',totalBytes:3,truncated:false,...input};delete answer.badShape;delete answer.badNonce;delete answer.badHead;if(input.badShape)answer.noevia='other';if(input.badNonce)answer.nonce='stale';if(input.badHead)answer.headSha='b'.repeat(40);socket.emit('data',Buffer.from(JSON.stringify(answer)+'\n'));});};return socket;
  }});
  const outcome=await verifier.run({workspaces:{verifyCheckout:()=>({source:'/source',headSha:head})},taskId:task,repo:'repo',headSha:head,revision:1,emit:(type,data)=>events.push({type,data})});
  fixtures.push({input,events,outcome});assert.equal(hangsUp,1);assert.equal(requests.length,1);if(outcome.report)assert.equal(verifier.isMeasured(outcome.report,{taskId:task,headSha:head,revision:1}),true);
 }
 assert.equal(fixtures[0].outcome.status,'passed');assert.equal(fixtures[4].outcome.status,'error');
 if(process.env.TASK_JOURNAL_EVIDENCE)fs.writeFileSync(path.join(process.env.TASK_JOURNAL_EVIDENCE,'task-verify-client-node.json'),JSON.stringify(fixtures,null,2)+'\n');
});
