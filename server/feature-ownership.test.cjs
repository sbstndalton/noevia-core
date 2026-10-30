'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const Database=require('better-sqlite3');
const {createRustAuthGuard}=require('./rust-auth.cjs');
const production=require('./features.cjs');
const {createFeatureRoutes,refuseOwnedFeatures,FEATURE_REFUSAL}=require('./routes/features.cjs');
const parseRequestUrl=req=>{try{return new URL(req.url,'http://localhost');}catch{return null;}};

test('every feature namespace refuses direct Node bypass before auth/body/facts',async()=>{
 let bodyReads=0;const json=(res,status,body)=>Object.assign(res,{status,body});
 const route=createFeatureRoutes({json,readJson:()=>{bodyReads++;throw Error('body must not be consumed');}});
 for(const path of ['/api/features','/api/admin/features','/api/admin/features/','/api/admin/features/%','/api/admin/features/a/b'])for(const method of ['GET','HEAD','OPTIONS','POST','PUT','DELETE','PATCH']) {
  const req={url:path,method,headers:{},on(){throw Error('body listener');}};
  const direct={};assert.equal(await route(req,direct,{path,authn:null}),true);assert.deepEqual(direct,{status:503,body:FEATURE_REFUSAL});
  const early={};assert.equal(refuseOwnedFeatures(req,early,{parseRequestUrl,json}),true);assert.deepEqual(early,direct);
 }
 for(const path of ['/api/features/','/api/features-x','/api/admin/features-x','/api/admin/decision-settings']) {
  assert.equal(refuseOwnedFeatures({url:path,headers:{}},{},{parseRequestUrl,json}),false,path);
 }
 assert.equal(bodyReads,0);
 assert.equal(production.createFeatures,undefined);assert.equal(production.migrateLegacySetting,undefined);
});

test('decision settings are the Rust front\'s: the feature routes no longer mount them (#2190)',async()=>{
 const json=(res,status,body)=>Object.assign(res,{status,body});
 const route=createFeatureRoutes({json});
 for(const path of ['/api/admin/decision-settings','/api/admin/decision-settings/test']) for(const method of ['GET','PUT','DELETE','POST']) {
  const out={};assert.equal(await route({method},out,{path,authn:{user:{id:'synthetic',role:'admin'}}}),false,`${method} ${path}`);assert.deepEqual(out,{});
 }
});

test('all canonical feature keys and legacy fallback remain native even inside exemptions and old statements',()=>{
 const db=new Database(':memory:');db.exec('CREATE TABLE settings(key TEXT PRIMARY KEY,value)');
 const oldInsert=db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)');
 const guard=createRustAuthGuard();guard.install(db);
 try {
  const names=Object.keys(production.REGISTRY);assert.equal(names.length,23);
  for(const name of [...names,'astraReview'])for(const exempt of [false,true]) {
   const run=()=>db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(`feature:${name}`,'true');
   assert.throws(()=>exempt?guard.exempt(run):run(),e=>e.status===503&&e.code==='RUST_FEATURES_OWNED');
   assert.throws(()=>oldInsert.run(`feature:${name}`,'true'),/RUST_FEATURES_OWNED/);
  }
  // #2190: the decision configuration is the Rust front's too, refused exempt or not.
  for(const exempt of [false,true]) {
   const run=()=>db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run('decision:configuration','synthetic');
   assert.throws(()=>exempt?guard.exempt(run):run(),e=>e.status===503&&e.code==='RUST_DECISION_SETTINGS_OWNED');
  }
  for(const key of ['inference:machines','other:setting']) {
   db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key,'synthetic');
   assert.equal(db.prepare('SELECT value FROM settings WHERE key=?').get(key).value,'synthetic');
  }
 } finally {db.close();}
});

test('device table writes cannot use the old wholesale revoke exemption',()=>{
 const db=new Database(':memory:');
 db.exec('CREATE TABLE device_authorizations(id);CREATE TABLE device_grants(id);CREATE TABLE device_tokens(id)');
 const guard=createRustAuthGuard();guard.install(db);
 try {for(const table of ['device_authorizations','device_grants','device_tokens'])for(const sql of [`DELETE FROM ${table}`,`INSERT INTO ${table}(id) VALUES(?)`,`UPDATE ${table} SET id=?`]) {
  assert.throws(()=>guard.exempt(()=>db.prepare(sql).run(...(sql.startsWith('DELETE')?[]:['synthetic']))),e=>e.code==='RUST_AUTH_OWNED');
 }}finally{db.close();}
});
