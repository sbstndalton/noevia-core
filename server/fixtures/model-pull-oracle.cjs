'use strict';
// Actual Core public handler + actual adapter; no network or model data.
const path=require('node:path');
const baseline=process.env.NOEVIA_ORACLE_CORE;
if(!baseline)throw Error('Set NOEVIA_ORACLE_CORE to the pinned pre-migration Core source');
const { createModelRoutes } = require(path.join(baseline,'server/routes/models.cjs'));
const { createModelManager } = require(path.join(baseline,'server/model-manager.cjs'));
const { fakeGate } = require('./fake-inference-gate.cjs');
const { createModelService } = require(path.join(baseline,'server/models.cjs'));
const { errorResponse } = require(path.join(baseline,'server/http.cjs'));
async function capture(c) {
  let request;
  const manager = createModelManager({kind: c.enabled ? 'llamacpp' : 'none', baseUrl: 'http://synthetic.invalid', gate: fakeGate(),
    fetchStream: async () => ({ok:false}), fetchJson: async (_url, init) => {
      request = JSON.parse(init.body);
      return {ok:c.ok,status:c.upstreamStatus,body:c.upstream};
    }});
  let answer;
  const routes = createModelRoutes({json:(_res,status,body)=>{answer={status,body};},readBody:async()=>c.raw,
    env:{},modelManager:manager,currentWorkspace:()=>({}),service:createModelService({env:{},modelManager:manager,currentWorkspace:()=>({}),fetchJson:async()=>({ok:false})})});
  try { await routes({method:'POST'}, {}, {path:'/api/models/pull',authn:{user:{id:'synthetic',role:'admin'}},url:new URL('http://synthetic.invalid/api/models/pull')}); }
  catch(error) {answer=errorResponse(error);}
  manager.close?.();
  if(request) answer.request=request;
  return answer;
}
const rawCases = [
  ['empty',''],['malformed','{'],['null','null'],['false','false'],['array','[]'],['missing','{}'],
  ...[null,false,0,'',{},[],['synthetic/repo'],[['synthetic/repo']],['synthetic/repo','other']].map((checkpoint,i)=>['type-'+i,JSON.stringify({checkpoint})]),
  ...['synthetic/repo','synthetic/repo:Q4_0','../repo','owner/..','a/b/c','a/b:', 'a/b:q:r','a/é','https://example.invalid/file','a/b\n','a/b\r\n','a/b\u0000','a/b\ud800'].map((checkpoint,i)=>['name-'+i,JSON.stringify({checkpoint})]),
  ['ignored-options','{"checkpoint":"synthetic/repo","modelName":{"nested":1},"recipe":[1]}'],
  ['shadowed-to-string','{"checkpoint":{"toString":null}}'],
  ['shadowed-to-string-named','{"checkpoint":{"toString":null},"modelName":"synthetic"}'],
  ['nested-shadowed-to-string','{"checkpoint":[{"toString":null}]}'],
  ['duplicate','{"checkpoint":"bad","checkpoint":"synthetic/repo:Q4"}'],
];
async function generate(){
  const cases=[];
  for(const [name,raw] of rawCases){const c={name,raw,enabled:true,ok:true,upstreamStatus:202,upstream:{id:'ignored',modelName:'ignored'}};cases.push({...c,expected:await capture(c)});}
  for(const upstream of [{error:'failed'},{error:{message:'failure'}},{error:[]},{error:0},{error:false},{},null]){
    const c={name:'upstream-'+cases.length,raw:'{"checkpoint":"synthetic/repo"}',enabled:true,ok:false,upstreamStatus:409,upstream};cases.push({...c,expected:await capture(c)});
  }
  for(const raw of ['{}','{"checkpoint":"bad"}','{"checkpoint":"synthetic/repo"}']){const c={name:'disabled-'+cases.length,raw,enabled:false,ok:true,upstreamStatus:200,upstream:{}};cases.push({...c,expected:await capture(c)});}
  return cases;
}
module.exports={capture,generate};
if(require.main===module)generate().then(c=>{const text=JSON.stringify(c,null,2)+'\n';if(process.env.NOEVIA_ORACLE_OUTPUT)require('node:fs').writeFileSync(process.env.NOEVIA_ORACLE_OUTPUT,text);else process.stdout.write(text);});
