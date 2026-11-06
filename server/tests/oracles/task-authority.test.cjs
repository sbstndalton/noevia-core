'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { createJobs, claimLifecycleAuthority } = require('../../jobs.cjs');
test('Planner authority measures current-round completeness and rejects forged reports', () => {
  const dir = fs.mkdtempSync(path.join(process.env.TASK_JOURNAL_EVIDENCE || os.tmpdir(), 'authority-oracle-'));
  try {
    const jobs = createJobs({dir, kinds:['code'], now:()=>1234});
    const token = claimLifecycleAuthority();
    const id = jobs.create({kind:'code', projectId:'p', capabilities:[]});
    const events=()=>fs.readFileSync(path.join(dir,'jobs',`${id}.jsonl`),'utf8').trim().split('\n').map(JSON.parse);
    const result = [];
    const put = (kind,data,authority=token) => {
      try {jobs.append(id,kind,data,authority);const rows=events();result.push({ok:true,data:rows.at(-1).data});}
      catch(error) {result.push({ok:false,status:error.status||null,message:error.message});}
    };
    const stage=(from,to,extra={})=>({from,to,revision:0,...extra});
    put('task.stage',stage('planned','implementing'),null);
    put('task.stage',stage('planned','implementing'));
    put('task.stage',stage('planned','implementing'));
    put('task.revision',{n:1,headSha:'a'.repeat(40),planHash:null,ignored:true});
    put('task.revision',{n:1,headSha:'a'.repeat(40)});
    const reviewing=stage('implementing','reviewing',{revision:1,expectedArtifacts:[],reportHash:'f'.repeat(64),report:{overall:'pass'},reason:'  ok\0\nnow  '});
    put('task.stage',reviewing);
    jobs.append(id,'step.started',{id:'tests',title:'Tests'});
    jobs.append(id,'step.completed',{id:'tests'});
    jobs.append(id,'checkpoint.created',{headSha:'a'.repeat(40)});
    jobs.append(id,'approval.requested',{id:'pending'});
    put('task.stage',reviewing);
    jobs.append(id,'approval.decided',{id:'pending',decision:'allow'});
    put('task.stage',reviewing);
    put('task.stage',stage('reviewing','implementing',{revision:1}));
    put('task.stage',reviewing);
    if(process.env.TASK_JOURNAL_EVIDENCE) fs.writeFileSync(path.join(process.env.TASK_JOURNAL_EVIDENCE,'task-authority-node.json'),JSON.stringify({id,result,events:events()},null,2)+'\n');
    assert.equal(result[0].status,403);
    assert.equal(result[2].message,'Stale task stage: the task is implementing');
    assert.equal(result[7].ok,true);
    assert.equal(result[7].data.reason,'ok now');
    assert.match(result[7].data.reportHash,/^[0-9a-f]{64}$/);
    assert.equal(result[9].status,409);

  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
