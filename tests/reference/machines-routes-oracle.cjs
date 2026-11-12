'use strict';
// Historical Node route oracle, synthetic dependencies and no engine requests.
const {createInferenceMachines}=require('./inference-machines.node.cjs');
const {createInferenceMachineRoutes}=require('./inference-machines-route.node.cjs');
(async()=>{
 const cases=[];
 for(const role of [null,'member','admin']) for(const method of ['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS']) for(const test of [
  {query:'',body:{}}, {query:'?health=1',body:{}}, {query:'?tune=1',body:{action:'tuneAbort'}},
  {query:'?models=missing&port=8080',body:{action:'assign',service:'missing'}},
  {query:'',body:null}, {query:'',body:[]}, {query:'',body:{action:'add'}},
  {query:'',body:{action:'remove',id:'missing'}},
  {query:'',body:{action:'tune',confirm:false,service:'chatFast'}},
  {query:'',invalid:true},
 ]) {
  const store=new Map();const machines=createInferenceMachines({store:{get:k=>store.get(k),set:(k,v)=>store.set(k,v)},log:()=>{}});
  const route=createInferenceMachineRoutes({json:(res,status,body)=>{res.status=status;res.body=body;},readJson:async()=>{if(test.invalid)throw Error('invalid');return test.body;},machines,health:{check:async()=>({})},chatMachines:{listModels:async()=>{throw Object.assign(Error('That machine is not on the list.'),{status:404,code:'unknownMachine'});}},machineTune:{status:()=>null,abort:()=>null,start:async()=>{throw Object.assign(Error('Confirm the measurement: it sends a few short requests to that machine.'),{status:400,code:'confirmRequired'});}}});
  const res={setHeader:()=>{},writeHead(status){this.status=status;},end(body){this.body=JSON.parse(body);}};if(!role)require('../../server/http.cjs').unauthorized(res);else await route({method},res,{path:'/api/models/machines',authn:role?{user:{id:'synthetic',role}}:null,url:new URL('http://localhost/api/models/machines'+test.query)});
  cases.push({role,method,...test,status:res.status,output:res.body});
 }
 process.stdout.write(JSON.stringify(cases,null,2)+'\n');
})().catch(e=>{console.error(e);process.exitCode=1;});
