'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs'),path=require('node:path');
const {buildMessages,prefixHash}=require('../../role-engine.cjs');
const {projectRoleContext,projectSharedDossier,serializeProjection,DOSSIER_ROLES}=require('../../role-context.cjs');
test('role prompts share only the projected dossier and isolate persona fields',()=>{
 const state={taskId:'task',tenantId:'tenant',revision:2,request:'Change the widget.',projectInstructions:'Preserve public exports.',capabilities:[{name:'read'},{name:'edit'}],plan:{goal:'Change widget',steps:[{n:1,do:'Edit widget',done_when:'tests pass'}]},execution:{headSha:'a'.repeat(40),changedFiles:['widget.js'],summary:'Changed widget'},change:{baseSha:'b'.repeat(40),headSha:'a'.repeat(40),files:[{path:'widget.js',patch:'+new line\n'}]}};
 const fixtures=[];
 for(const role of DOSSIER_ROLES){for(const correction of [null,{violation:{message:'Expected an object',path:'$'}}]){
  const shared=projectSharedDossier(state,{roles:DOSSIER_ROLES}).dossier,own=projectRoleContext(role,state).projection;
  const fields=Object.fromEntries(Object.entries(own).filter(([key])=>!Object.hasOwn(shared,key)));
  const dossier=serializeProjection(shared),instructions=`Instructions for ${role}`;
  const messages=buildMessages({dossier,instructions,fields:serializeProjection(fields),correction});
  fixtures.push({role,state,roles:DOSSIER_ROLES,model:'synthetic-model',thinking:false,instructions,correction,messages,prefix:prefixHash({model:'synthetic-model',thinking:false,dossier})});
  assert.equal(messages.length,2);assert.equal(messages[1].role,'user');
 }}
 assert.equal(new Set(fixtures.map(f=>f.prefix)).size,1);
 if(process.env.TASK_JOURNAL_EVIDENCE)fs.writeFileSync(path.join(process.env.TASK_JOURNAL_EVIDENCE,'task-role-prompts-node.json'),JSON.stringify(fixtures,null,2)+'\n');
});
