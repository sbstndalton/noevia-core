'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createReasoningSettingsRoutes, enabledFrom } = require('./reasoning-settings.cjs');
const { createRustAuthGuard } = require('../rust-auth.cjs');
const env = { NOEVIA_FRONT:'rust', NOEVIA_RUST_AUTH:'1', NOEVIA_RUST_AUTH_CONFIRMED:'1', NOEVIA_RUST_REASONING_SETTINGS:'1', NOEVIA_RUST_REASONING_SETTINGS_CONFIRMED:'1' };

test('only all five exact ownership signals activate reasoning PUT refusal', async () => {
  assert.equal(enabledFrom(env), true);
  for (const key of Object.keys(env)) for (const value of [undefined,'','0','true',' 1','1 ']) {
    assert.equal(enabledFrom({...env,[key]:value}),false,`${key}/${value}`);
  }
  for (const role of ['admin','member']) {
    let sent;
    const route=createReasoningSettingsRoutes({env,json:(_res,status,body)=>{sent={status,body};},readBody:()=>{throw Error('body must not be read');},authService:{db:{prepare:()=>{throw Error('settings must not be touched');}},audit:()=>{throw Error('audit must not run');}}});
    assert.equal(await route({method:'PUT'},{},{path:'/api/reasoning-settings',authn:{user:{role}}}),true);
    assert.deepEqual(sent,{status:503,body:{error:'Reasoning settings are owned by the Rust front.'}});
  }
});

test('confirmed reasoning ownership preserves original GET and other methods', async () => {
  let sent;
  const route=createReasoningSettingsRoutes({env,json:(_res,status,body)=>{sent={status,body};},authService:{db:{prepare:()=>({get:()=>({value:'low'})})}},reasoningEffort:{resolveEffort:(_p,d)=>d,modeFor:()=> 'synthetic-mode'},getProvider:()=>({}),DEFAULT_PROVIDER_ID:'synthetic'});
  await route({method:'GET'},{},{path:'/api/reasoning-settings',url:new URL('http://synthetic/api/reasoning-settings'),authn:{user:{role:'admin'}}});
  assert.deepEqual(sent,{status:200,body:{default:'low',effort:'low',mode:'synthetic-mode',admin:true}});
  for (const method of ['POST','DELETE','PATCH','HEAD','OPTIONS']) {
    await route({method},{},{path:'/api/reasoning-settings',authn:{user:{role:'admin'}}});
    assert.deepEqual(sent,{status:405,body:{error:'Method not allowed'}});
  }
});

test('reasoning guard refuses its exact key and unknown SQL shapes without widening other owners', () => {
  const Database=require('better-sqlite3');
  for (const enabled of [false,true]) {
    const db=new Database(':memory:');
    try {
      db.exec("CREATE TABLE settings(key TEXT PRIMARY KEY,value); INSERT INTO settings VALUES('reasoning_effort_default','low'); INSERT INTO settings VALUES('unrelated','kept')");
      const guard=createRustAuthGuard({enabled,reasoningSettingsEnabled:true});guard.install(db);
      for (const attempt of [
        ()=>db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('reasoning_effort_default',?)").run('high'),
        ()=>db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run('reasoning_effort_default','high'),
        ()=>db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').bind(['reasoning_effort_default','high']).run(),
        ()=>db.prepare("DELETE FROM settings WHERE key='reasoning_effort_default'").run(),
        ()=>db.prepare("UPDATE settings SET value='high'").run(),
        ()=>db.exec("DELETE FROM settings"),
        ()=>guard.exempt(()=>db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run('reasoning_effort_default','high')),
      ]) assert.throws(attempt,{code:'RUST_REASONING_SETTINGS_OWNED',status:503});
      assert.equal(db.prepare("SELECT value FROM settings WHERE key='reasoning_effort_default'").get().value,'low');
      db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run('auto_sampling_presets_enabled','false');
      db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run('unrelated','changed');
      if (enabled) assert.throws(()=>db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run('public_origin','synthetic'),{code:'RUST_AUTH_OWNED'});
      else db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run('public_origin','synthetic');
      assert.equal(db.prepare("SELECT value FROM settings WHERE key='unrelated'").get().value,'changed');
    } finally { db.close(); }
  }
});

test('each missing confirmation preserves original Node setting and audit writes', async () => {
  const Database=require('better-sqlite3');
  for (const key of Object.keys(env)) {
    const db=new Database(':memory:');
    try {
      db.exec('CREATE TABLE settings(key TEXT PRIMARY KEY,value);CREATE TABLE audit_events(action TEXT,actor TEXT,detail TEXT)');
      let sent;
      const route=createReasoningSettingsRoutes({env:{...env,[key]:undefined},json:(_res,status,body)=>{sent={status,body};},readBody:async()=>'{"default":"high"}',reasoningEffort:require('../reasoning-effort.cjs'),authService:{db,audit:(action,actor,_target,detail)=>db.prepare('INSERT INTO audit_events VALUES(?,?,?)').run(action,actor,JSON.stringify(detail))}});
      await route({method:'PUT'},{},{path:'/api/reasoning-settings',authn:{user:{id:'synthetic',role:'admin'}}});
      assert.deepEqual(sent,{status:200,body:{default:'high'}},key);
      assert.equal(db.prepare("SELECT value FROM settings WHERE key='reasoning_effort_default'").get().value,'high',key);
      assert.deepEqual(db.prepare('SELECT * FROM audit_events').all(),[{action:'reasoning.default',actor:'synthetic',detail:'{"effort":"high"}'}],key);
    } finally { db.close(); }
  }
});
