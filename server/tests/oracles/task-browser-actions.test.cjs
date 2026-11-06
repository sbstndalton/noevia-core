'use strict';const{test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
test('Browser native action actor matches Node cards and outcomes',async()=>{
 const source=fs.readFileSync(path.join(__dirname,'../../browser-executor.test.cjs'),'utf8');
 const helper=source.slice(source.indexOf('function fakeBrowser('),source.indexOf("test('a session is refused")).replace('evaluate: async () => ({ inForm: false }),','evaluateHandle: async () => null, evaluate: async () => ({ inForm: false }),');
 const make=vm.runInThisContext('(function(require,temp){const fs=require("node:fs"),ORIGIN="https://shop.example.test",SECRET="synthetic-secret-7731";const{createBrowserExecutor}=require("../../browser-executor.cjs");'+helper+';return {session,submitButton,textField};})');
 const dirs=[];const {session,submitButton,textField}=make(require,()=>{const d=fs.mkdtempSync(path.join(process.env.TMPDIR,'task-browser-oracle-'));dirs.push(d);return d;});const rows=[];
 try{
 for(const [name,action,answer,mode] of [
 ['read',{type:'click',selector:'#read'},'deny'],['deny',{type:'click',selector:'#submit'},'deny'],['allow',{type:'click',selector:'#submit'},'approve'],['target changed',{type:'click',selector:'#submit'},'approve','target'],['page changed',{type:'click',selector:'#submit'},'approve','page'],
 ['plain type',{type:'type',selector:'#field',text:'hello'},'deny'],['secret type',{type:'type',selector:'#field',text:'{{secret:token}}'},'deny'],['unknown secret',{type:'type',selector:'#field',text:'{{secret:missing}}'},'deny'],['select',{type:'select',selector:'#field',value:'one'},'deny'],['missing',{type:'click',selector:'#missing'},'approve'],['unknown',{type:'invented'},'approve'],['post',{type:'navigate',url:'https://shop.example.test/',method:'POST'},'approve'],['navigate',{type:'navigate',url:'https://shop.example.test/read'},'deny'],['upload',{type:'upload',selector:'#field',file:'missing'},'approve'],['screenshot',{type:'screenshot'},'deny'],['extract',{type:'extract',selector:'#read'},'deny'],['body',{type:'extract'},'deny'],['press',{type:'press',key:'Enter'},'deny'],['hover',{type:'hover',selector:'#read'},'deny'],['scroll',{type:'scroll',dy:0},'deny'],['wait',{type:'wait',ms:0},'deny']]){
  const dom={'#submit':{...submitButton},'#field':{...textField},'#read':{tag:'a',type:'',role:'',name:'Read more',text:'Read more',value:'',inForm:false,formMethod:''}};
  const secrets={token:{value:'synthetic-secret-7731',domains:['shop.example.test']}};
  const s=await session({dom,secrets,answers:[answer],onApproval:async(card,fake)=>{if(mode==='target')dom['#submit']={...dom['#submit']};if(mode==='page')fake.setUrl('https://other.example.test/');}});
  const result=await s.act(action);rows.push({name,action,answer,mode:mode||null,dom:{'#submit':submitButton,'#field':textField,'#read':dom['#read']},secrets,result,cards:s.cards,disposals:s.disposals});await s.executor.shutdown();
 }
 assert.equal(rows.length,21);assert.equal(rows.find(r=>r.name==='target changed').result.status,'blocked');
 if(process.env.TASK_JOURNAL_EVIDENCE)fs.writeFileSync(path.join(process.env.TASK_JOURNAL_EVIDENCE,'task-browser-actions-node.json'),JSON.stringify(rows,null,2)+'\n');
 }finally{for(const d of dirs)fs.rmSync(d,{recursive:true,force:true});}
});
