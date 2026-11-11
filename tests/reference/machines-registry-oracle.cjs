// Run against the pre-port Core checkout; synthetic registry only.
'use strict';
const {createInferenceMachines}=require('./inference-machines.node.cjs');
(async()=>{
 const rows=new Map(); const m=createInferenceMachines({store:{get:k=>rows.get(k),set:(k,v)=>rows.set(k,v)},lookup:async()=>[{address:'192.168.1.2',family:4}],log:()=>{}});
 const cases=[]; const record=async(name,fn)=>{try{const body=await fn();cases.push({name,status:200,body,state:rows.has('inference:machines')?JSON.parse(rows.get('inference:machines')):null});}catch(e){cases.push({name,status:e.status,body:{error:e.message,code:e.code,...(e.services?{services:e.services}:{})},state:rows.has('inference:machines')?JSON.parse(rows.get('inference:machines')):null});}};
 await record('empty',()=>m.view());
 for(const body of [{},{name:'box',address:'8.8.8.8'},{name:'box',address:'192.168.1.2:8080'},{name:'box',address:'192.168.1.2'}]) await record('add '+JSON.stringify(body),()=>m.add(body,'synthetic-admin'));
 const id=m.view().machines[1].id;
 await record('duplicate name',()=>m.add({name:'BOX',address:'192.168.1.3'}));
 await record('duplicate address',()=>m.add({name:'other',address:'192.168.1.2'}));
 await record('assign',()=>m.assign({service:'decision',machine:id,port:8040}));
 await record('remove assigned',()=>m.remove({id}));
 await record('unassign',()=>m.assign({service:'decision',machine:'local'}));
 await record('remove',()=>m.remove({id}));
 const text=JSON.stringify({cases,state:rows.get('inference:machines')},null,2).replaceAll(id,'<machine>');
 process.stdout.write(text+'\n');
})().catch(e=>{console.error(e);process.exitCode=1;});
