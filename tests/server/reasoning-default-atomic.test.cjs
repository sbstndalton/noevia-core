'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createReasoningSettingsRoutes } = require('../../server/routes/reasoning-settings.cjs');
const reasoningEffort = require('../../server/reasoning-effort.cjs');
function fixture() {
  const db = new Database(':memory:');
  db.exec("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE audit_events(actor_user_id TEXT,target_user_id TEXT,action TEXT,detail TEXT,created_at INTEGER); INSERT INTO settings VALUES('reasoning_effort_default','low');");
  const audit = (action, actor, target, detail = {}) => db.prepare('INSERT INTO audit_events(actor_user_id,target_user_id,action,detail,created_at) VALUES(?,?,?,?,?)').run(actor || null, target || null, action, JSON.stringify(detail), Date.now());
  let response;
  let reads = 0;
  const route = createReasoningSettingsRoutes({ json: (_res,status,body) => { response = {status,body}; }, readBody: async () => { reads++; return '{"default":"high"}'; }, authService:{db,audit}, reasoningEffort });
  const invoke = (role = 'admin') => route({method:'PUT'}, {}, {path:'/api/reasoning-settings',authn:{user:{role,id:'synthetic-admin'}},url:new URL('http://synthetic/api/reasoning-settings')});
  return {db,invoke,response:()=>response,reads:()=>reads,value:()=>db.prepare('SELECT value FROM settings').get().value};
}
test('reasoning default and authenticated audit commit together', async () => {
  const f = fixture();
  try {
    assert.equal(await f.invoke(), true);
    assert.deepEqual(f.response(), {status:200,body:{default:'high'}});
    assert.equal(f.value(), 'high');
    assert.deepEqual(f.db.prepare('SELECT actor_user_id,target_user_id,action,detail FROM audit_events').get(), {actor_user_id:'synthetic-admin',target_user_id:null,action:'reasoning.default',detail:'{"effort":"high"}'});
  } finally { f.db.close(); }
});
test('audit abort rolls back setting and restores transaction state', async () => {
  const f = fixture();
  try {
    f.db.exec("CREATE TRIGGER reject_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'synthetic audit abort'); END;");
    await assert.rejects(f.invoke(), /synthetic audit abort/);
    assert.equal(f.value(), 'low');
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM audit_events').get().n, 0);
    assert.equal(f.db.inTransaction, false);
    assert.equal(f.response(), undefined);
    f.db.exec('DROP TRIGGER reject_audit');
    await f.invoke();
    assert.equal(f.value(), 'high');
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM audit_events').get().n, 1);
  } finally { f.db.close(); }
});
test('member rejection performs no body read, setting write or audit', async () => {
  const f = fixture();
  try {
    await f.invoke('member');
    assert.deepEqual(f.response(), {status:403,body:{error:'Administrator required'}});
    assert.equal(f.reads(), 0);
    assert.equal(f.value(), 'low');
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM audit_events').get().n, 0);
  } finally { f.db.close(); }
});
