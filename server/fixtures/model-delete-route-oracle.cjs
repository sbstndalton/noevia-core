'use strict';
// Regenerate against the pre-migration Core source via NOEVIA_ORACLE_CORE.
const path=require('node:path'),fs=require('node:fs');
const baseline=process.env.NOEVIA_ORACLE_CORE;
if(!baseline)throw Error('NOEVIA_ORACLE_CORE must name the pinned legacy Core source');
const {createModelRoutes}=require(path.join(baseline,'server/routes/models.cjs'));
const system=require(path.join(baseline,'server/model-system.cjs'));
const {createModelService}=require(path.join(baseline,'server/models.cjs'));
system.rememberSectionRoles('{"synthetic-system":"system-routing"}');
const cases=[
 {name:'success',raw:'{"name":"synthetic"}',known:true,ok:true,status:200,unloaded:true},
 {name:'matched-before-null',raw:'{"name":"synthetic"}',known:true,ok:true,status:200,unloaded:true,listing:[{id:'synthetic',status:{args:[]}},null]},
 {name:'null-before-match',raw:'{"name":"synthetic"}',known:true,ok:true,status:200,unloaded:true,listing:[null,{id:'synthetic',status:{args:[]}}]},
 {name:'unknown',raw:'{"name":"unknown"}',known:true,ok:true,status:200,unloaded:true},
 {name:'traversal',raw:'{"name":"../../outside"}',known:true,ok:true,status:200,unloaded:true},
 {name:'system',raw:'{"name":"synthetic-system"}',known:true,ok:true,status:200,unloaded:true},
 {name:'system-confirmed',raw:'{"name":"synthetic-system","confirmSystem":true}',known:true,ok:true,status:200,unloaded:true},
 {name:'system-confirm-string',raw:'{"name":"synthetic-system","confirmSystem":"true"}',known:true,ok:true,status:200,unloaded:true},
 ...['','{','null','false','[]','{}','{"name":""}','{"name":false}','{"name":[]}','{"name":{}}','{"name":"\\ud800"}'].map((raw,i)=>({name:'invalid-'+i,raw,known:true,ok:true,status:200,unloaded:true})),
 {name:'plain-failure',raw:'{"name":"synthetic"}',known:true,ok:false,status:500,unloaded:false},
 ...[true,{reason:'busy'},'x'.repeat(299)+'😀tail','\ud800'].map((message,i)=>({name:'gate-message-'+i,raw:'{"name":"synthetic"}',known:true,ok:false,status:409,unloaded:false,error:{error:{type:'gate_error',code:'model_in_use',message,retryable:true}}})),
 {name:'in-use',raw:'{"name":"synthetic"}',known:true,ok:false,status:409,unloaded:false,error:{error:{type:'gate_error',code:'model_in_use',message:'Busy',retryable:true}}},
];
async function capture(c){let answer;const workspace={autoRoles:{fast:'synthetic',smart:'other'},saveAutoRoles(){}};const shared=createModelService({fetchJson:async()=>({ok:false}),env:{},modelManager:{enabled:false},currentWorkspace:()=>workspace,listWorkspaces:()=>[workspace]});const service={modelScanCache:{clear(){}},modelsInstalled:async()=>[{name:'synthetic'},{name:'synthetic-system'}],clearRoleReferences:shared.clearRoleReferences,lastLoadedModel:()=>null,clearLastLoadedModel(){}};
 const manager={enabled:true,kind:'llamacpp',request:async()=>({ok:true,body:{data:c.listing||[{id:'synthetic',status:{args:[]}}]}}),removeModel:async()=>({ok:c.ok,status:c.status,unloaded:c.unloaded,body:c.error||{}})};
 const route=createModelRoutes({json:(_r,status,body)=>{answer={status,body};},readBody:async()=>c.raw,env:{},modelManager:manager,service,currentWorkspace:()=>({})});
 try{await route({method:'POST'},{},{path:'/api/models/delete',authn:{user:{id:'admin',role:'admin'}},url:new URL('http://synthetic.invalid/api/models/delete')});}catch{answer={status:500,body:{error:'Internal error'}};}
 return answer;
}
(async()=>{const result=[];for(const c of cases)result.push({...c,expected:await capture(c)});const text=JSON.stringify(result,null,2)+'\n';if(process.env.NOEVIA_ORACLE_OUTPUT)fs.writeFileSync(process.env.NOEVIA_ORACLE_OUTPUT,text);else process.stdout.write(text);})();
