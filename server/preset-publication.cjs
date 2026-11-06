'use strict';
// Shared with model-publication: a transaction is an OS-released publication mutex,
// never an expiring maintenance lease. Contents remain in models.ini.
const PUBLICATION_CLIENT_MARKER = 'noevia-preset-publication-client/1';
const path = require('node:path');
const Database = require('better-sqlite3');
function withPublication(file, write) {
  const lock = path.join(path.dirname(file), '.' + path.basename(file) + '.noevia-publication.sqlite');
  let db;
  try {
    db = new Database(lock, { timeout: 5000 });
    db.exec('BEGIN EXCLUSIVE');
    return write();
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
