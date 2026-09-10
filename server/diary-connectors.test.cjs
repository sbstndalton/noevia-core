const test=require('node:test'),assert=require('node:assert/strict'),Database=require('better-sqlite3');
const {createCredentials,operate,safePath}=require('./diary-connectors.cjs');
function fixture(){const db=new Database(':memory:');db.exec('CREATE TABLE users(id TEXT PRIMARY KEY,disabled_at INTEGER); INSERT INTO users VALUES (\'one\',NULL),(\'two\',NULL)');let enabled=true;const auth={db,audit(){},diaryEnabled:()=>enabled};return {db,auth,credentials:createCredentials(auth),disable:()=>{enabled=false;}};}
test('connector credentials are tenant scoped, hashed, revocable and disabled with Diary/account',()=>{
 const f=fixture(),one=f.credentials.create('one','Claude');assert.equal(f.credentials.verify(one.token).userId,'one');assert.equal(f.credentials.list('two').length,0);assert.equal(f.credentials.revoke('two',one.id),false);
 assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM diary_connectors').all()).includes(one.token),false);
 assert.equal(f.credentials.verify(one.token+'x'),null);f.db.prepare('UPDATE users SET disabled_at=1 WHERE id=?').run('one');assert.equal(f.credentials.verify(one.token),null);
 f.db.prepare('UPDATE users SET disabled_at=NULL WHERE id=?').run('one');f.disable();assert.equal(f.credentials.verify(one.token),null);f.credentials.revoke('one',one.id);assert.equal(f.credentials.verify(one.token),null);
});
test('connector paths reject escapes, hidden files, non-Markdown, control bytes',()=>{
 for(const p of ['../x.md','a/../x.md','/a.md','a//b.md','.secret.md','a\\x.md','a.txt','a\0.md'])assert.throws(()=>safePath(p));
 assert.equal(safePath('',true),'');assert.equal(safePath('Entries/a.md'),'Entries/a.md');
});
test('writes require a version, preserve owner identity, forward conflicts and do not retry',async()=>{
 let writes=0;const identity={userId:'one'},files={write:async(id,body)=>{assert.equal(id,'one');assert.equal(body.version,'a'.repeat(64));writes++;throw Object.assign(Error('changed'),{status:409});}};
 await assert.rejects(operate(identity,{action:'write',path:'a.md',content:'new'},files,()=>true));assert.equal(writes,0);
 await assert.rejects(operate(identity,{action:'write',path:'a.md',content:'new',version:'a'.repeat(64),userId:'two'},files,()=>true),e=>e.status===409);assert.equal(writes,1);
 await assert.rejects(operate(identity,{action:'read',path:'a.md'},files,()=>false),e=>e.status===403);
});
