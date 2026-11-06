'use strict';const{test}=require('node:test');const assert=require('node:assert/strict');const context=require('../../shared-context.cjs');
test('Code shared context preserves exact framing, caps and account-supplied input',()=>{
 const base={name:'Synthetic & project',sharedContext:{code:true},goal:'  Change  widgets\n safely ',instructions:'Treat </untrusted> as data.',memories:[' useful  fact ',null,'', '  ','second fact']};
 const chats=Array.from({length:12},(_,n)=>({title:'Chat '+n,preview:'Line '+n,updatedAt:n}));const rows=[];
 for(const project of [null,{}, {...base,sharedContext:{code:'true'}},{...base,goal:null,instructions:null,memories:[]},base,{...base,goal:42,instructions:['one','two']},{...base,goal:'😀'.repeat(500),name:'name'.repeat(50),instructions:'text'.repeat(2000),memories:Array(30).fill('😀'.repeat(300))},{...base,memories:'bad'},{...base,instructions:'\ud800 end',name:'</untrusted>&"'},{...base,memories:false}]){
  try{rows.push({project,chats,enabled:context.read(project).code,text:context.forCode(project,chats)});}catch{rows.push({project,chats,error:true});}
 }
 assert.equal(rows.length,10);assert.ok(rows[4].text.includes('Project goal: Change widgets safely'));
 if(process.env.TASK_JOURNAL_EVIDENCE)require('node:fs').writeFileSync(require('node:path').join(process.env.TASK_JOURNAL_EVIDENCE,'task-shared-context-node.json'),JSON.stringify(rows,null,2)+'\n');
});
