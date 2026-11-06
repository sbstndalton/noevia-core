'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
test('preset recovery cannot retire a pending managed-service effect', t=>{
  const publication=require('./preset-publication.cjs');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'publication-recovery-'));
  const file=path.join(dir,'models.ini');
  const previous=process.env.NOEVIA_PRESET_AUTHORITY_FILE;
  process.env.NOEVIA_PRESET_AUTHORITY_FILE=path.join(dir,'authority.sqlite');
  t.after(()=>{if(previous===undefined)delete process.env.NOEVIA_PRESET_AUTHORITY_FILE;else process.env.NOEVIA_PRESET_AUTHORITY_FILE=previous;fs.rmSync(dir,{recursive:true,force:true});});
  publication.withPublication(file,db=>db.prepare("INSERT INTO preset_operations(id,incarnation,lease,generation,kind,state) VALUES('service','front','grant','1','service-start','recovery')").run());
  assert.throws(()=>publication.assertPresetRecovery(),{status:503});
  publication.withPublication(file,db=>db.prepare("UPDATE preset_operations SET state='settled' WHERE id='service'").run());
  assert.doesNotThrow(()=>publication.assertPresetRecovery());
  publication.withPublication(file,db=>db.prepare("INSERT INTO preset_operations(id,incarnation,lease,generation,kind,state) VALUES('preset','front','grant','1','reload','recovery')").run());
  assert.doesNotThrow(()=>publication.assertPresetRecovery());
});
const worker = `
const fs=require('node:fs');
const {createPresetStore}=require(process.argv[1]);
const [file,base,before,text,pause]=process.argv.slice(2);
if(pause==='yes'){
 const rename=fs.renameSync;
 fs.renameSync=(a,b)=>{
  if(b===file){fs.writeFileSync(file+'.ready','');const wait=new Int32Array(new SharedArrayBuffer(4));while(!fs.existsSync(file+'.resume'))Atomics.wait(wait,0,0,10);}
  return rename(a,b);
 };
}
createPresetStore(file).commit({baseRevision:base,before,text}).then(()=>process.stdout.write('200')).catch(e=>{process.stdout.write(String(e.status||500));});
`;
function client(module, file, base, before, text, pause) {
  const child = spawn(process.execPath, ['-e', worker, module, file, base, before, text, pause], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', d => { stdout += d; });
  child.stderr.on('data', d => { stderr += d; });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
  });
  return { child, done };
}
test('independent processes serialize revision read through rename and reject the stale publisher', { timeout: 20000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'models.ini');
  const before = '[m]\nmodel = /models/m.gguf\n';
  const a = before + 'ctx-size = 8192\n', b = before + 'ctx-size = 16384\n';
  fs.writeFileSync(file, before);
  const base = crypto.createHash('sha256').update(before).digest('hex');
  const module = require.resolve('./llamacpp-presets.cjs');
  const first = client(module, file, base, before, a, 'yes');
  try {
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(file + '.ready')) {
      assert.ok(Date.now() < deadline, 'first publisher reached rename barrier');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    // A has read the revision, written/fsynced its temp file and is stopped before rename.
    // B is a real second process, so an in-process mutex cannot protect this interval.
    const second = client(module, file, base, before, b, 'no');
    assert.equal(await second.done, '503', 'B must not publish while A owns publication');
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'no torn or premature publication');
  } finally {
    fs.writeFileSync(file + '.resume', '');
    assert.equal(await first.done, '200');
  }
  assert.equal(fs.readFileSync(file, 'utf8'), a);
  const stale = client(module, file, base, before, b, 'no');
  assert.equal(await stale.done, '409', 'stale revision refused after publication settles');
  assert.equal(fs.readFileSync(file, 'utf8'), a);
});

test('a separate publisher rejects an authority generation changed after its permit was issued', async t=>{
  const Database=require('better-sqlite3');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'publication-generation-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'models.ini'),authority=path.join(dir,'authority.sqlite');
  const before='[m]\nmodel = /models/m.gguf\n',after=before+'ctx-size = 8192\n';
  fs.writeFileSync(file,before);const base=crypto.createHash('sha256').update(before).digest('hex');
  const db=new Database(authority);db.pragma('journal_mode = WAL');
  db.exec("CREATE TABLE preset_authority(singleton INTEGER PRIMARY KEY,incarnation TEXT,lease TEXT,generation TEXT,active INTEGER,until_ms TEXT,recovery INTEGER); CREATE TABLE preset_operations(id TEXT PRIMARY KEY,incarnation TEXT,lease TEXT,generation TEXT,kind TEXT,expected_revision TEXT,state TEXT,revision TEXT,created_ms INTEGER); CREATE TABLE preset_revision(singleton INTEGER PRIMARY KEY,revision TEXT)");
  db.prepare('INSERT INTO preset_authority VALUES(1,?,?,?,1,?,0)').run('front','lease','2',String(Date.now()+60000));
  const fence={incarnation:'front',lease:'lease',generation:1,operation:'stale-op',kind:'preset-write',expectedRevision:base};
  db.prepare("INSERT INTO preset_operations VALUES(?,?,?,?,?,?,'issued',NULL,?)").run(fence.operation,'front','lease','1',fence.kind,base,Date.now());db.close();
  const module=process.env.NOEVIA_PUBLICATION_TEST_STORE || require.resolve('./llamacpp-presets.cjs');
  const script=`const {createPresetStore}=require(process.argv[1]); const [file,base,before,text,fence]=process.argv.slice(2);createPresetStore(file).commit({baseRevision:base,before,text},{maintenance:JSON.parse(fence)}).then(()=>process.stdout.write('200')).catch(e=>process.stdout.write(String(e.status||500)));`;
  const child=spawn(process.execPath,['-e',script,module,file,base,before,after,JSON.stringify(fence)],{env:{...process.env,NOEVIA_PRESET_AUTHORITY_FILE:authority},stdio:['ignore','pipe','pipe']});
  let result='',errors='';child.stdout.on('data',b=>result+=b);child.stderr.on('data',b=>errors+=b);
  const code=await new Promise((resolve,reject)=>{child.on('close',resolve);child.on('error',reject);});
  assert.equal(code,0,errors);assert.equal(result,'409','a correct INI revision does not authorize a stale holder');
  assert.equal(fs.readFileSync(file,'utf8'),before,'stale process made no file or torn publication');
});
