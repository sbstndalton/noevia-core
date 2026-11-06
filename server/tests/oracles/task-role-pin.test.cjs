'use strict';const{test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs'),path=require('node:path');const{createRoleEngine}=require('../../role-engine.cjs');
test('task model pinning never loads or switches models and binds a remote target',async()=>{
 const cases=[{}, {external:true}, {configured:false}, {loaded:['other']}, {model:null}, {model:null,loaded:['resident']}, {budget:'The model does not fit the inference memory budget.'}, {machine:true,loaded:['other'],budget:'ignored local budget'}, {machine:true,wanted:'other'}, {machine:true,ready:false}, {task:''}];const fixtures=[];
 for(const input of cases){let sends=0;const target={machine:{id:'m',name:'Synthetic machine'},baseUrl:'http://engine.invalid/v1',model:'served'};
 const engine=createRoleEngine({engine:()=>({baseUrl:input.configured===false?null:'http://engine.invalid/v1',external:input.external===true,model:Object.hasOwn(input,'model')?input.model:'synthetic',...(input.machine?{machine:target}:{})}),loadedModels:async()=>input.loaded||[],budgetRefusal:async()=>input.budget?{error:input.budget}:null,fetch:async()=>{sends++;throw Error('must not load');},machines:{ready:async()=>input.ready===false?{ok:false,code:'machineUnreachable',error:'The Code role’s machine is unreachable.'}:{ok:true},fetch:async()=>{sends++;throw Error('must not send');}}});
 const pinned=await engine.pinModel({taskId:input.task??'task',model:input.wanted??null,roles:['planner'],thinking:false});const result=pinned.ok?{ok:true,model:pinned.session.model,thinking:pinned.session.thinking,machine:pinned.session.machine,roles:pinned.session.roles}:pinned;
 fixtures.push({input,result});assert.equal(sends,0);
 }assert.equal(fixtures[3].result.code,'model_mismatch');assert.equal(fixtures[7].result.model,'served');
 if(process.env.TASK_JOURNAL_EVIDENCE)fs.writeFileSync(path.join(process.env.TASK_JOURNAL_EVIDENCE,'task-role-pin-node.json'),JSON.stringify(fixtures,null,2)+'\n');
});
