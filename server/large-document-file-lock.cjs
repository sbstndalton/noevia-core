'use strict';
// sbstndalton/noevia#2191 round 7 (review of rounds 4+5, #697): the host-wide half of the
// large-document lock. large-document-lock.cjs serialises one large document per process; the Rust
// front (noevia-rs crates/server-projects extract.rs `large_lock`) extracts large documents too, so
// both take this file as well and only one large document is ever held on the host.
//
// Protocol (both sides keep it): UI_DATA_DIR/large-document.lock is an SQLite file. The holder keeps a
// `BEGIN IMMEDIATE` transaction open (SQLite's RESERVED lock: one writer per file across processes);
// nothing is ever written. A holder that dies frees it with its file locks. A waiter polls POLL_MS apart
// with no busy timeout, so it never blocks the event loop, and gives up at its deadline.
const fs = require('node:fs');
const path = require('node:path');

const LOCK_FILE = 'large-document.lock';
const POLL_MS = 200;

function lockPath(env = process.env) {
  return path.join(env.UI_DATA_DIR || path.join(__dirname, 'ui-data'), LOCK_FILE);
}

function open(file) {
  let DatabaseSync = null;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch { /* older runtime */ }
  if (DatabaseSync) { const db = new DatabaseSync(file); db.exec('PRAGMA busy_timeout = 0'); return db; }
  const Database = require('better-sqlite3');
  const db = new Database(file, { timeout: 0 });
  return db;
}

const isBusy = (err) => /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database is busy/i.test(`${err?.code || ''} ${err?.errcode || ''} ${err?.message || ''}`);

/** One attempt: the open handle holding the lock, or null when another process holds it. Any other
 *  error is thrown (the lock is never skipped). */
function tryTake(file) {
  const db = open(file);
  try { db.exec('BEGIN IMMEDIATE'); return db; } catch (err) {
    try { db.close(); } catch { /* closing a failed handle */ }
    if (isBusy(err)) return null;
    throw err;
  }
}

/** Take the lock, polling until `deadline` (ms since the epoch). Resolves a `release`, or null past the
 *  deadline. When the data directory does not exist (a unit test with no UI_DATA_DIR) there is no host
 *  to share it with: resolves a no-op release. */
async function take(deadline, file = lockPath()) {
  if (!fs.existsSync(path.dirname(file))) return () => {};
  for (;;) {
    const db = tryTake(file);
    if (db) {
      let released = false;
      return () => {
        if (released) return; released = true;
        try { db.exec('ROLLBACK'); } catch { /* closing frees it anyway */ }
        try { db.close(); } catch { /* already closed */ }
      };
    }
    const left = deadline - Date.now();
    if (left <= 0) return null;
    await new Promise((resolve) => setTimeout(resolve, Math.min(left, POLL_MS)));
  }
}

module.exports = { LOCK_FILE, POLL_MS, lockPath, tryTake, take };
