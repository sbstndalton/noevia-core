'use strict';
// Shared with model-publication: a transaction is an OS-released publication mutex,
// never an expiring maintenance lease. Contents remain in models.ini.
const PUBLICATION_CLIENT_MARKER = 'noevia-preset-publication-client/2';
const path = require('node:path');
const Database = require('better-sqlite3');
function withPublication(file, write) {
  const lock = authorityPath(file);
  let db;
  try {
    db = new Database(lock, { timeout: 5000 });
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.exec('BEGIN EXCLUSIVE');
    return write(db);
  } catch (e) {
    if (e.code === 'SQLITE_BUSY' || e.code === 'SQLITE_LOCKED') {
      const failure = new Error('Preset publication is busy or unavailable. Try again shortly.');
      failure.status = 503;
      failure.publicMessage = failure.message;
      throw failure;
    }
    throw e;
  } finally {
    if (db) db.close();
  }
}
module.exports = { withPublication, PUBLICATION_CLIENT_MARKER };

function authorityPath(file) {
  return process.env.NOEVIA_PRESET_AUTHORITY_FILE || path.join(path.dirname(file), '.' + path.basename(file) + '.noevia-publication.sqlite');
}
function coverageError() {
  return Object.assign(Error('The maintenance operation is no longer covered.'), {status:503, publicMessage:'The maintenance operation is no longer covered.', maintenanceCoverageLost:true});
}
function validate(db, fence) {
  const r = db.prepare('SELECT * FROM preset_authority WHERE singleton=1').get();
  if (!r || !r.active || r.incarnation !== fence.incarnation || r.lease !== fence.lease || String(r.generation) !== String(fence.generation) || Date.now() >= r.until_ms) throw coverageError();
  const op = db.prepare('SELECT id FROM preset_operations WHERE id=? AND incarnation=? AND lease=? AND generation=?').get(fence.operation, fence.incarnation, fence.lease, String(fence.generation));
  if (!op) throw coverageError();
}
function beginOperation(grant) {
  const file = process.env.NOEVIA_PRESET_AUTHORITY_FILE;
  if (!file || !grant) return null;
  const fence = { incarnation:grant.epoch, lease:grant.authorityLease || grant.token, generation:grant.generation, operation:require('node:crypto').randomBytes(16).toString('hex') };
  const db = new Database(file, {timeout:5000});
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.exec('BEGIN EXCLUSIVE');
    const r = db.prepare('SELECT * FROM preset_authority WHERE singleton=1').get();
    if (!r || !r.active || r.incarnation !== fence.incarnation || r.lease !== fence.lease || String(r.generation) !== String(fence.generation) || Date.now() >= r.until_ms) throw coverageError();
    db.prepare('INSERT INTO preset_operations VALUES(?,?,?,?)').run(fence.operation,fence.incarnation,fence.lease,String(fence.generation));
    db.exec('COMMIT');
  } finally {db.close();}
  return { fence, settle() {
    const db = new Database(file, {timeout:5000});
    try {
      db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.exec('BEGIN EXCLUSIVE');
      db.prepare('DELETE FROM preset_operations WHERE id=? AND incarnation=? AND lease=? AND generation=?').run(fence.operation,fence.incarnation,fence.lease,String(fence.generation));
      db.exec('COMMIT');
    } finally {db.close();}
  }};
}
function admissionClosed() {
  const file = process.env.NOEVIA_PRESET_AUTHORITY_FILE;
  if (!file) return false;
  let db;
  try {
    db = new Database(file, {readonly:true, fileMustExist:true, timeout:0});
    const r = db.prepare('SELECT active,recovery FROM preset_authority WHERE singleton=1').get();
    return !r || !!r.active || !!r.recovery || !!db.prepare('SELECT id FROM preset_operations LIMIT 1').get();
  } catch {return true;} finally {db?.close();}
}
module.exports.authorityPath = authorityPath;
module.exports.validate = validate;
module.exports.beginOperation = beginOperation;
module.exports.admissionClosed = admissionClosed;

function incidentPending() {
  const file=process.env.NOEVIA_PRESET_AUTHORITY_FILE;
  if(!file)return false;
  let db;
  try {
    db=new Database(file,{readonly:true,fileMustExist:true,timeout:0});
    const r=db.prepare('SELECT recovery FROM preset_authority WHERE singleton=1').get();
    return !r||!!r.recovery||!!db.prepare('SELECT id FROM preset_operations LIMIT 1').get();
  } catch {return true;} finally {db?.close();}
}
module.exports.incidentPending=incidentPending;
