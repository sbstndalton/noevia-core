'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs'),path=require('node:path');
const {createRoleEngine}=require('../../role-engine.cjs');const {DOSSIER_ROLES}=require('../../role-context.cjs');
test('role streaming captures constraint fallback and one bounded correction',async()=>{
 const state={taskId:'task',tenantId:'tenant',revision:2,request:'Change the widget.',projectInstructions:'Preserve public exports.',capabilities:[{name:'read'},{name:'edit'}],plan:{goal:'Change widget',steps:[{n:1,do:'Edit widget',done_when:'tests pass'}]},execution:{headSha:'a'.repeat(40),changedFiles:['widget.js'],summary:'Changed widget'},change:{baseSha:'b'.repeat(40),headSha:'a'.repeat(40),files:[{path:'widget.js',patch:'+new line\n'}]}};
 const schema={type:'object',required:['answer'],additionalProperties:false,properties:{answer:{type:'string'}}};
 const requests=[],replies=[422,'bad','{"answer":"fine"}'];let closed=0;
 const engine=createRoleEngine({engine:()=>({baseUrl:'http://engine.invalid/v1',model:'synthetic-model',provider:{capabilities:{jsonSchemaParam:true}}}),loadedModels:async()=>['synthetic-model'],fetch:async(_url,init)=>{
  requests.push(JSON.parse(init.body));const reply=replies.shift();if(typeof reply==='number')return new Response('synthetic reflected token never read',{status:reply});
  const raw=`data: ${JSON.stringify({choices:[{delta:{content:reply}}]})}\n\ndata: [DONE]\n\n`;
  let done=false;return new Response(new ReadableStream({pull(c){if(done){c.close();return;}done=true;c.enqueue(new TextEncoder().encode(raw));},cancel(){closed++;}},{highWaterMark:0}));
 }});
 const pinned=await engine.pinModel({taskId:'task',model:'synthetic-model',roles:DOSSIER_ROLES});assert.equal(pinned.ok,true);
 const answer=await pinned.session.call({role:'planner',state,instructions:'Instructions for planner',schema,schemaName:'answer',constrain:true,maxTokens:1400,maxBytes:32768});
 assert.equal(answer.ok,true);assert.equal(answer.corrected,true);assert.equal(answer.attempts,2);assert.equal(requests.length,3);assert.equal(closed,2);
 if(process.env.TASK_JOURNAL_EVIDENCE)fs.writeFileSync(path.join(process.env.TASK_JOURNAL_EVIDENCE,'task-role-stream-node.json'),JSON.stringify({state,schema,roles:DOSSIER_ROLES,requests,answer},null,2)+'\n');
});
