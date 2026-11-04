'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {owned,refuseOwned,OWNED_ROUTES}=require('./rust-model-evidence-recheck.cjs');
test('only the exact public recheck POST is native-owned',()=>{
  assert.deepEqual([...OWNED_ROUTES],['POST /api/models/evidence/recheck']);
  assert.equal(owned('POST','/api/models/evidence/recheck'),true);
  for(const [m,p] of [['GET','/api/models/evidence/recheck'],['PUT','/api/models/evidence/recheck'],['POST','/api/models/evidence/recheck/'],['POST','/api/models/evidence/import']]) assert.equal(owned(m,p),false);
  const r={};assert.equal(refuseOwned({method:'POST'},r,{parseRequestUrl:()=>({pathname:'/api/models/evidence/recheck'}),json:(res,status,body)=>Object.assign(res,{status,body})}),true);
  assert.equal(r.status,503);assert.equal(r.body.code,'RUST_MODEL_EVIDENCE_RECHECK_OWNED');
});
test('Node no longer runs the public image probe or files its recheck record',()=>{
  const source=fs.readFileSync(path.join(__dirname,'routes/models.cjs'),'utf8');
  assert.equal(source.includes('createVisionProbe'),false);
  assert.equal(source.includes("source:'recheck'"),false);
  const index=fs.readFileSync(path.join(__dirname,'index.cjs'),'utf8');
  assert.ok(index.indexOf("require('./rust-model-evidence-recheck.cjs').refuseOwned(")<index.indexOf('async function handleRequestScoped('),'refused before auth/workspace');
});
