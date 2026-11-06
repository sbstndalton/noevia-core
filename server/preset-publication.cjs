'use strict';
// Shared authority schema and transaction with Rust model-publication. Model bytes stay in models.ini.
const PUBLICATION_CLIENT_MARKER = 'noevia-preset-publication-client/2';
const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');
const Database = require('better-sqlite3');
const pending = "state IN ('issued','running','recovery')";
function authorityPath(file) {
  return process.env.NOEVIA_PRESET_AUTHORITY_FILE || path.join(path.dirname(file), '.' + path.basename(file) + '.noevia-publication.sqlite');
}
function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS preset_authority(singleton INTEGER PRIMARY KEY CHECK(singleton=1),incarnation TEXT NOT NULL,lease TEXT NOT NULL,generation TEXT NOT NULL,active INTEGER NOT NULL,until_ms TEXT NOT NULL,recovery INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS preset_operations(id TEXT PRIMARY KEY,incarnation TEXT NOT NULL,lease TEXT NOT NULL,generation TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS preset_revision(singleton INTEGER PRIMARY KEY CHECK(singleton=1),revision TEXT NOT NULL);`);
  const columns = new Set(db.pragma('table_info(preset_operations)').map(r=>r.name));
  for (const [name, type] of [['kind',"TEXT NOT NULL DEFAULT 'legacy'"],['expected_revision','TEXT'],['state',"TEXT NOT NULL DEFAULT 'issued'"],['revision','TEXT'],['created_ms','INTEGER NOT NULL DEFAULT 0']]) {
    if (!columns.has(name)) db.exec(`ALTER TABLE preset_operations ADD COLUMN ${name} ${type}`);
  }
  if (db.pragma('user_version',{simple:true}) < 2) db.pragma('user_version = 2');
}
function transaction(file, write) {
  let db;
  try {
    db = new Database(file, {timeout:5000});
    fs.chmodSync(file,0o644);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.exec('BEGIN EXCLUSIVE');
    for(const suffix of ['-wal','-shm'])try{fs.chmodSync(file+suffix,0o644);}catch(e){if(e.code!=='ENOENT')throw e;}
    migrate(db);
    const result = write(db);
    db.exec('COMMIT');
    return result;
  } catch (e) {
    if (e.code === 'SQLITE_BUSY' || e.code === 'SQLITE_LOCKED') {
      throw Object.assign(Error('Preset publication is busy or unavailable. Try again shortly.'), {status:503,publicMessage:'Preset publication is busy or unavailable. Try again shortly.'});
    }
    throw e;
  } finally { db?.close(); }
}
function withPublication(file, write) { return transaction(authorityPath(file),write); }
function coverageError() {
  return Object.assign(Error('The maintenance operation is no longer covered.'), {status:409,publicMessage:'The maintenance operation is no longer covered.',maintenanceCoverageLost:true});
}
function validateLease(db, fence) {
  const r=db.prepare('SELECT * FROM preset_authority WHERE singleton=1').get();
  if (!r || !r.active || r.incarnation!==fence.incarnation || r.lease!==fence.lease || String(r.generation)!==String(fence.generation) || Date.now()>=Number(r.until_ms)) throw coverageError();
}
function validate(db, fence, actualRevision) {
  validateLease(db,fence);
  const op=db.prepare("SELECT id FROM preset_operations WHERE id=? AND incarnation=? AND lease=? AND generation=? AND kind=? AND expected_revision IS ? AND state IN ('issued','running')")
    .get(fence.operation,fence.incarnation,fence.lease,String(fence.generation),fence.kind,fence.expectedRevision??null);
  if (!op) throw coverageError();
  if (actualRevision!==undefined && fence.expectedRevision!=null && actualRevision!==fence.expectedRevision) throw Object.assign(Error('Presets changed while applying. Reload before retrying.'),{status:409});
}
function finish(db,fence,state='settled',revision=null) {
  db.prepare(`UPDATE preset_operations SET state=?,revision=COALESCE(?,revision) WHERE id=? AND incarnation=? AND lease=? AND generation=? AND ${pending}`)
    .run(state,revision,fence.operation,fence.incarnation,fence.lease,String(fence.generation));
}
function observeRevision(db,revision) {
  db.prepare('INSERT INTO preset_revision VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision').run(revision);
}
function beginOperation(grant,kind='control',expectedRevision=null,presetFile=null) {
  const file=process.env.NOEVIA_PRESET_AUTHORITY_FILE;
  if (!file || !grant) return null;
  const fence={incarnation:grant.epoch,lease:grant.authorityLease||grant.token,generation:grant.generation,operation:crypto.randomBytes(16).toString('hex'),kind,expectedRevision};
  transaction(file,db=>{
    validateLease(db,fence);
    if(presetFile && expectedRevision!==null){
      const actual=crypto.createHash('sha256').update(fs.readFileSync(presetFile)).digest('hex');
      if(actual!==expectedRevision)throw Object.assign(Error('Presets changed while applying. Reload before retrying.'),{status:409});
      observeRevision(db,actual);
    }
    db.prepare("INSERT INTO preset_operations(id,incarnation,lease,generation,kind,expected_revision,state,created_ms) VALUES(?,?,?,?,?,?,'issued',?)")
      .run(fence.operation,fence.incarnation,fence.lease,String(fence.generation),kind,expectedRevision,Date.now());
  });
  return {fence,settle(revision=null) {transaction(file,db=>finish(db,fence,'settled',revision));},unknown() {transaction(file,db=>finish(db,fence,'recovery'));}};
}
function readClosed(includeActive) {
  const file=process.env.NOEVIA_PRESET_AUTHORITY_FILE;
  if (!file) return false;
  let db;
  try {
    db=new Database(file,{readonly:true,fileMustExist:true,timeout:25});
    const r=db.prepare('SELECT active,recovery FROM preset_authority WHERE singleton=1').get();
    return !r || (includeActive && !!r.active) || !!r.recovery || !!db.prepare(`SELECT id FROM preset_operations WHERE ${pending} LIMIT 1`).get();
  } catch { return true; } finally { db?.close(); }
}
module.exports={withPublication,PUBLICATION_CLIENT_MARKER,authorityPath,validate,finish,observeRevision,beginOperation,
  admissionClosed:()=>readClosed(true),incidentPending:()=>readClosed(false)};
