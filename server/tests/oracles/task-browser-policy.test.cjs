'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const policy=require('../../browser-policy.cjs');
test('Browser native host projections preserve the existing policy authority',()=>{
 const rows=[];
 const pages=[{}, {origin:'https://synthetic.invalid',allowedDomains:['synthetic.invalid']},{origin:42,allowedDomains:'bad'}, {origin:false,allowedDomains:[null,42,'synthetic.invalid']}];
 const actions=[{},{type:'navigate',url:'https://synthetic.invalid/path'},{type:'navigate',url:'https://127.1/'},{type:'navigate',url:'https://synthetic.invalid/',method:'POST'}, {type:'navigate'}, {type:'press',key:'Enter'}, {type:'press',key:0}, {type:'click',element:{tag:'button',text:'Send',inForm:true}}, {type:'click',element:{tag:'a',text:'Read more'}}, {type:'click',element:{tag:42,text:['Save',null],inForm:[]}}, {type:'click',element:{tag:'button',text:'𓀀'}}, {type:'type'}, {type:'extract'}, {type:'screenshot'}, {type:'unknown'}, {type:17}];
 for(const action of actions)for(const page of pages) rows.push({kind:'classify',action,page,result:policy.classifyAction(action,page)});
 for(const url of ['https://synthetic.invalid/path','https://localhost./','https://127.1/','http://10.0.0.1/','https://user:pass@synthetic.invalid/','data:text/plain,hello',null,42])for(const domains of [[],['synthetic.invalid'],'bad',[null,42,'synthetic.invalid']])rows.push({kind:'navigation',url,domains,result:policy.checkNavigation(url,domains)});
 assert.equal(rows.length,96);assert.ok(rows.some(r=>r.result.status==='needs_approval'));
 if(process.env.TASK_JOURNAL_EVIDENCE)require('node:fs').writeFileSync(require('node:path').join(process.env.TASK_JOURNAL_EVIDENCE,'task-browser-policy-node.json'),JSON.stringify(rows,null,2)+'\n');
});
