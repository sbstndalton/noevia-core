'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createChatTurns } = require('./chat-turns.cjs');
function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'noevia-turn-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const workspace={dir,userId:'tenant-a'}, service=createChatTurns({enabled:true});
  const turn=service.start(workspace,{projectId:'project-a',conversationId:'conversation-a',messages:[{role:'user',content:'synthetic'}],model:{id:'original',effort:'low'}});
  return {dir,workspace,service,turn};
}
const tool={id:'call-1',name:'synthetic_write',args:'{"text":"fixture"}'};
test('default-off creates no state',()=>assert.throws(()=>createChatTurns().start({},{}),/Conversation|disabled/));
test('model failure restores identity, full results and explicit outputs with a mocked replacement',async t=>{
  const f=fixture(t); f.turn.generation({messages:[]},0); f.turn.output('Checking', [tool]);
  f.turn.approval(tool.id,{id:'ap-1',action:'approve_all'}); f.turn.approval(tool.id,{action:'approve_all',inherited:true}); f.turn.started(tool.id);
  f.turn.result(tool.id,'full result '.repeat(2000)); f.turn.generation({messages:[{role:'tool',content:'reduced'}]},1);
  f.turn.partial('incomplete response'); f.turn.interrupt('model died');
  const service=createChatTurns({enabled:true}), restored=service.restore(f.workspace,f.turn.id);
  assert.equal(restored.next,'generate'); assert.equal(restored.state.calls[0].result.length,24000);
  assert.equal(restored.state.calls[0].approval.action,'approve_all'); assert.equal(restored.state.calls[0].approval.id,'ap-1');
  let calls=0;
  const result=await service.resumeGeneration(f.workspace,f.turn.id,{
    model:{id:'replacement'},project: state=>{assert.equal(state.messages.at(-1).content.length,24000); return state.messages.map(m=>m.role === 'tool' ? {...m,content:'reduced'} : m);},
    provider:async request=>{calls++;assert.equal(request.model.id,'replacement');return {content:'Recovered'};}
  });
  assert.equal(calls,1);assert.deepEqual(result.identity,restored.state.identity);
  assert.equal(result.model.id,'original');assert.equal(result.models.at(-1).id,'replacement');
  assert.equal(result.retries.remaining,0);assert.equal(result.outputs[1].partial,true);
  await assert.rejects(service.resumeGeneration(f.workspace,f.turn.id,{}),/completed/);
});
test('process interruption during a tool requires review and cannot execute again',async t=>{
  const f=fixture(t);f.turn.output('',[tool]);f.turn.started(tool.id);
  const service=createChatTurns({enabled:true}), restored=service.restore(f.workspace,f.turn.id);
  assert.equal(restored.next,'review');assert.equal(restored.unresolved[0].status,'outcome_unknown');
  assert.throws(()=>f.turn.started(tool.id),/already started/);
  await assert.rejects(service.resumeGeneration(f.workspace,f.turn.id,{provider:()=>assert.fail('must not call')}),/review/);
});
for(const action of ['pending','approve','deny','approve_all']) test(`preserves ${action} as history and re-asks unresolved approval`,t=>{
  const f=fixture(t);f.turn.output('',[tool]);f.turn.approval(tool.id,{id:'ap-1',action});
  const restored=createChatTurns({enabled:true}).restore(f.workspace,f.turn.id);
  assert.equal(restored.next,'approval');assert.equal(restored.unresolved[0].approval.action,action);assert.equal(restored.unresolved[0].reask,true);
});
test('tenant and project identity cannot be replaced on restore',t=>{
  const f=fixture(t);
  assert.throws(()=>f.service.restore({...f.workspace,userId:'tenant-b'},f.turn.id),/No such/);
  assert.throws(()=>f.service.restore({dir:path.join(f.dir,'other'),userId:'tenant-b'},f.turn.id),/No such/);
  assert.equal(f.service.restore(f.workspace,f.turn.id).state.identity.projectId,'project-a');
});
test('failed replacement consumes its retry durably',async t=>{
  const f=fixture(t);f.turn.interrupt('failed');
  await assert.rejects(f.service.resumeGeneration(f.workspace,f.turn.id,{model:{id:'mock'},project:s=>s.messages,provider:async()=>{throw Error('mock crash');}}),/mock crash/);
  assert.equal(createChatTurns({enabled:true}).restore(f.workspace,f.turn.id).next,'budget_exhausted');
});
test('corrupt or truncated journal fails closed, never resumes earlier tool state',t=>{
  const f=fixture(t);f.turn.output('',[tool]);f.turn.started(tool.id);
  fs.appendFileSync(path.join(f.dir,'jobs',f.turn.id+'.jsonl'),'{partial');
  assert.throws(()=>f.service.restore(f.workspace,f.turn.id),/review required/);
});
test('valid JSON tampering fails hash verification',t=>{
  const f=fixture(t),file=path.join(f.dir,'jobs',f.turn.id+'.jsonl');
  fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('synthetic','tampered'));
  assert.throws(()=>f.service.restore(f.workspace,f.turn.id),/review required/);
});
test('legacy jobs and durable chat coexist in the same tenant directory',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'noevia-jobs-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const {createJobs}=require('./jobs.cjs'),jobs=createJobs({dir,kinds:['code']});jobs.create({kind:'code'});
  const service=createChatTurns({enabled:true}), turn=service.start({dir,userId:'a'},{conversationId:'c',messages:[],model:{id:'m'}});
  assert.equal(jobs.list().length,2);assert.equal(service.restore({dir,userId:'a'},turn.id).next,'generate');
});
test('concurrent replacement attempts cannot spend the same retry twice',async t=>{
  const f=fixture(t);let release;
  const first=f.service.resumeGeneration(f.workspace,f.turn.id,{model:{id:'mock'},project:()=>new Promise(resolve=>{release=()=>resolve([{role:'user',content:'fixture'}]);}),provider:async()=>({content:'done'})});
  await assert.rejects(createChatTurns({enabled:true}).resumeGeneration(f.workspace,f.turn.id,{}),/budget_exhausted/);
  release();await first;
});
for(const projection of [[{role:'tool',tool_call_id:'orphan',content:'x'}],[{role:'assistant',tool_calls:[{id:'missing'}]}]]) test('replacement rejects incomplete tool projection',async t=>{
  const f=fixture(t);await assert.rejects(f.service.resumeGeneration(f.workspace,f.turn.id,{model:{id:'mock'},project:()=>projection,provider:()=>assert.fail('invalid projection reached provider')}),/tool group/);
});
test('returned tool errors after start remain ambiguous',t=>{
  const f=fixture(t);f.turn.output('',[tool]);f.turn.started(tool.id);f.turn.result(tool.id,'ERROR: timeout after submission');
  const restored=f.service.restore(f.workspace,f.turn.id);assert.equal(restored.next,'review');
  assert.equal(restored.state.messages.at(-1).role,'assistant');assert.match(restored.state.calls[0].error,/timeout/);
});
test('the last tool round cannot gain an extra generation on restore',t=>{
  const f=fixture(t);f.turn.generation({messages:[]},2);f.turn.output('',[tool]);f.turn.started(tool.id);f.turn.result(tool.id,'done');f.turn.interrupt('request ended');
  assert.equal(f.service.restore(f.workspace,f.turn.id).next,'budget_exhausted');
});
test('a stale recorder cannot overwrite a consumed replacement budget',async t=>{
  const f=fixture(t);let release;
  const pending=f.service.resumeGeneration(f.workspace,f.turn.id,{model:{id:'mock'},project:()=>new Promise(resolve=>{release=()=>resolve([]);}),provider:async()=>({content:'done'})});
  assert.throws(()=>f.turn.partial('stale output'),/Turn changed/);release();await pending;
});

for (const phase of ['generation', 'tool']) test(`SIGKILL during ${phase} restores from a separate process without replay`, {timeout:10000}, async t => {
  const {spawn} = require('node:child_process');
  const {once} = require('node:events');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-process-turn-'));
  const workspace = {dir, userId:'synthetic-process-tenant'};
  const worker = spawn(process.execPath, ['-e', `
    const {createChatTurns}=require(process.argv[1]);
    const service=createChatTurns({enabled:true});
    const turn=service.start({dir:process.argv[2],userId:'synthetic-process-tenant'},
      {projectId:'synthetic-project',conversationId:'synthetic-chat',messages:[{role:'user',content:'fixture'}],model:{id:'mock'}});
    turn.generation({messages:[]},0);
    turn.output('Explicit intermediate output',[{id:'persisted-call',name:'mock_write',args:'{}'}]);
    turn.approval('persisted-call',{id:'persisted-approval',action:'approve_all'});
    turn.started('persisted-call');
    if(process.argv[3]==='generation'){
      turn.result('persisted-call','Confirmed synthetic result');
      turn.generation({messages:[{role:'user',content:'mock next request'}]},1);
    }
    process.stdout.write(turn.id+'\\n');
    setInterval(()=>{},1000);
  `, require.resolve('./chat-turns.cjs'), dir, phase], {stdio:['ignore','pipe','pipe']});
  const exited = once(worker,'exit');
  t.after(async()=>{if(worker.exitCode===null && worker.signalCode===null)worker.kill('SIGKILL');await exited;fs.rmSync(dir,{recursive:true,force:true});});
  let stderr='';worker.stderr.on('data',data=>{stderr+=data;});
  const id = await new Promise((resolve,reject)=>{
    let output='';
    worker.stdout.on('data',data=>{output+=data;if(output.includes('\n'))resolve(output.trim());});
    worker.once('error',reject);
    worker.once('exit',()=>reject(Error('Fixture exited before checkpoint: '+stderr)));
  });
  worker.kill('SIGKILL');
  const [,signal] = await exited;assert.equal(signal,'SIGKILL');
  const service = createChatTurns({enabled:true}), restored=service.restore(workspace,id);
  assert.equal(restored.state.identity.projectId,'synthetic-project');
  assert.equal(restored.state.identity.conversationId,'synthetic-chat');
  assert.equal(restored.state.calls[0].id,'persisted-call');
  assert.equal(restored.state.calls[0].approval.id,'persisted-approval');
  assert.equal(restored.state.calls[0].approval.action,'approve_all');
  assert.equal(restored.state.outputs[0].content,'Explicit intermediate output');
  if(phase==='tool'){
    assert.equal(restored.next,'review');
    await assert.rejects(service.resumeGeneration(workspace,id,{provider:()=>assert.fail('Ambiguous effect must block continuation')}),/review/);
  }else{
    assert.equal(restored.next,'generate');
    let requests=0;
    const result=await service.resumeGeneration(workspace,id,{model:{id:'replacement-mock'},project:state=>state.messages,
      provider:async({messages})=>{requests++;assert.equal(messages.at(-1).content,'Confirmed synthetic result');return {content:'Restored'};}});
    assert.equal(requests,1);assert.deepEqual(result.identity,restored.state.identity);
    assert.equal(result.calls.length,1);assert.equal(result.calls[0].result,'Confirmed synthetic result');
  }
});
