'use strict';
// sbstndalton/noevia#2191 round 2: the re-reader for a file the Rust front writes and this process
// only reads. No boot cache: each use stats the file (and, for SQLite, its -wal) and reloads only
// when the stamp (ino, size, mtime) changed, so a write on the other side is seen on the next use.
// A file that disappears is seen as absent; one replaced by a rename (a new inode) is reloaded; a
// handle `load` opened for an old stamp is closed by `onDrop` before the new one is taken.
//
//   const reader = createStampedReader({ files: [db, `${db}-wal`], load: () => readIt(db), onDrop });
//   reader.get()        // the loaded value, reloaded when any file's stamp changed
//   reader.changed()    // whether the stamp moved since the last get (no load)
//
// `load` returns the value (anything); a throw is not cached: the next get tries again, and `fallback`
// is answered meanwhile. Used by rust-index-outbox.cjs for the index outbox and its tombstones.
const fs = require('node:fs');

function stampOf(file, statSync = fs.statSync) {
  try { const st = statSync(file); return `${st.ino}:${st.size}:${st.mtimeMs}`; }
  catch (err) { if (err && err.code === 'ENOENT') return '-'; throw err; }
}

function createStampedReader({ files, load, onDrop = () => {}, fallback = null, statSync = fs.statSync }) {
  if (!Array.isArray(files) || !files.length) throw new TypeError('createStampedReader needs files');
  let stamp = null;
  let value = fallback;
  const current = () => files.map((f) => stampOf(f, statSync)).join('|');
  function drop() {
    if (stamp === null) return;
    const old = value;
    stamp = null;
    value = fallback;
    try { onDrop(old); } catch { /* a close that fails leaves nothing to keep */ }
  }
  return {
    get() {
      let now;
      try { now = current(); } catch { drop(); return fallback; }
      if (now === stamp) return value;
      drop();
      let next;
      try { next = load(); } catch { return fallback; }
      // A write between the stat and the load is caught by the next stat: the stamp is the older one.
      stamp = now; value = next;
      return value;
    },
    changed() { try { return current() !== stamp; } catch { return true; } },
    drop,
  };
}

module.exports = { createStampedReader, stampOf };
