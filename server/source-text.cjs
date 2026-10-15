'use strict';
// #1806: a project source's extracted text lives in its own file, not in projects.json.
//
// On disk (projects.json) a text source is metadata only:
//   { name, ..., textRef: '<sha256 of the text, hex>', chars: <text.length>, skillHeader?: true }
// and its text is `<workspace dir>/project-sources/<project id>/<textRef>.txt` (0600, in a 0700
// directory, written to a temp file and renamed: a crash leaves the old state or the new one).
// Content addressing makes a write idempotent and a retry safe: the same text is the same file.
//   textRef      the text file's name; the pointer every writer of projects.json must keep (the
//                Rust projects front, noevia-rs crates/server-projects, keeps every field as is)
//   chars        the text's length, so a reader that only needs the size (the chat file
//                injection's small/large split, coverage, the source list) does not read the file
//   skillHeader  true when the text opens with a front-matter block naming a skill: what
//                instruction-skills.cjs reconcile needs, so a save does not read every source
//
// In memory, each such file gets an enumerable, configurable `content` accessor that reads the
// text on demand (through a small byte-bounded cache) and a non-enumerable toJSON that leaves the
// accessor out. So every reader of `file.content` keeps working, a spread copy (`{ ...f }`) carries
// the text as a plain value, JSON.stringify (projects.json, the API, rust-projects.cjs's merge
// base) never carries it, and assigning `file.content = text` turns it back into a plain value that
// the next save writes out (externalize) before projects.json is written.
//
// Migration (migrateOnLoad): a projects.json written before this holds the text inline. When one
// is loaded its bytes are first copied to `<workspace dir>/migration-backups/projects-pre-1806-
// <sha256 prefix>.json` (0600; never overwritten: the name is the content), then each text is
// written to its file, then projects.json is saved without it. Idempotent (nothing inline is left
// to move) and safe if interrupted: the texts are written before the file that points at them, and
// a rerun repeats the same steps from the inline copy still on disk.
//
// Rollback: code from before #1806 reads `content` only, so it would see every migrated source as
// empty (it keeps the textRef fields it does not know). To go back, stop the Node server AND the Rust
// front (noevia-server, which writes projects.json under NOEVIA_RUST_PROJECTS), then either
//   node server/source-text.cjs inline <workspace dir>
// which reads every text strictly first (a missing or mismatched file aborts before anything is
// written), takes the projects.json flock, and writes the text back after its own backup; or restore the newest
// migration-backups/projects-pre-1806-*.json over projects.json (sources added since are lost).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = 'project-sources';
const REF = /^[0-9a-f]{64}$/;
const CACHE_MAX_CHARS = 32 * 1024 * 1024;

const refOf = (text) => crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
const safeId = (id) => String(id).replace(/[^a-zA-Z0-9_-]/g, '');
const projectDir = (wsDir, projectId) => path.join(wsDir, DIR, safeId(projectId));
const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
/** instruction-skills.cjs isFrontMatterSkill's header half: the front matter names a skill. */
const headerNamesSkill = (text) => { const h = FRONT_MATTER.exec(String(text || '')); return !!h && /^(?:name|description)\s*:/im.test(h[1]); };

// Read cache: path -> text, least recently used first out. Text files never change once written
// (the name is the content), so a cached entry is never stale.
const cache = new Map();
let cached = 0;
function remember(file, text) {
  if (text.length > CACHE_MAX_CHARS / 4) return;
  cache.set(file, text); cached += text.length;
  for (const [k, v] of cache) { if (cached <= CACHE_MAX_CHARS) break; cache.delete(k); cached -= v.length; }
}
const warned = new Set();
// Text files a read failed for, `<dir>|<project>|<ref>`. A source copied from such a read (a spread,
// documentSources.failed) carries '' with the old textRef; externalize keeps that pointer rather than
// saving '' over it (#1806 review), so a text that comes back (a restore) is found again.
const unreadable = new Set();
const missingKey = (wsDir, projectId, ref) => `${wsDir}|${safeId(projectId)}|${ref}`;

/** The text, read strictly: throws when the file is missing, unreadable or not the text the
 *  pointer names (the rollback must never write a guess). */
function readTextStrict(wsDir, projectId, ref) {
  if (!REF.test(String(ref))) throw Object.assign(new Error(`invalid text pointer ${String(ref).slice(0, 80)}`), { code: 'SOURCE_TEXT_INVALID' });
  const file = path.join(projectDir(wsDir, projectId), `${ref}.txt`);
  const text = fs.readFileSync(file, 'utf8');
  if (refOf(text) !== ref) throw Object.assign(new Error(`${file} does not hold the text its pointer names`), { code: 'SOURCE_TEXT_MISMATCH' });
  return text;
}

/** The text for a reader: '' when it cannot be read (logged once, and remembered so a save keeps the pointer). */
function readText(wsDir, projectId, ref) {
  if (!REF.test(String(ref))) return '';
  const file = path.join(projectDir(wsDir, projectId), `${ref}.txt`);
  const hit = cache.get(file);
  if (hit !== undefined) { cache.delete(file); cache.set(file, hit); return hit; }
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (e) {
    unreadable.add(missingKey(wsDir, projectId, ref));
    if (!warned.has(file)) { warned.add(file); console.warn(`[sources] text of a source is missing (${e.code || e.message}); it reads as empty and its pointer is kept`); }
    return '';
  }
  unreadable.delete(missingKey(wsDir, projectId, ref));
  remember(file, text);
  return text;
}

function fsyncPath(p, flags = 'r') {
  const fd = fs.openSync(p, flags);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** Writes the text durably: temp file, fsync, rename, fsync of the folder. A file already there is
 *  kept only when it is exactly this text (same size, same hash); a zero-length, torn or otherwise
 *  different file is rewritten.
 *  #1815: with `pendingDirs` (a Set), the folder fsync is not done here: the folders to fsync are
 *  added to the set and the caller fsyncs each once (flushDirs) before it commits projects.json.
 *  The file's own data is still fsynced before its rename, so the order stays: data durable, then
 *  the rename, then (batched) the folder entry, then projects.json. */
function writeText(wsDir, projectId, ref, text, pendingDirs = null) {
  const dir = projectDir(wsDir, projectId);
  const file = path.join(dir, `${ref}.txt`);
  const bytes = Buffer.from(text, 'utf8');
  try {
    const st = fs.statSync(file);
    if (st.isFile() && st.size === bytes.length && refOf(fs.readFileSync(file, 'utf8')) === ref) {
      // #1818: the file may be one an earlier, failed save renamed into place without fsyncing its
      // folder; the folder is fsynced again before projects.json can point at it.
      // #1819: with every folder up to the workspace, since the project folder itself may be one
      // that failed save created without fsyncing its entry in project-sources/.
      const dirs = pendingDirs || new Set();
      addChain(wsDir, dir, dirs);
      if (!pendingDirs) flushDirs(dirs);
      written(wsDir, projectId, ref);
      return;
    }
  } catch { /* absent: written below */ }
  const created = fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  const dirs = pendingDirs || new Set();
  dirs.add(dir);
  // A folder just created is itself a new entry in its parent(s): those are made durable too.
  if (created) { const top = path.dirname(created); for (let d = dir; d !== top && d !== path.dirname(d);) { d = path.dirname(d); dirs.add(d); } }
  // #1819: in a batch, always every folder up to the workspace: a retry after a failed save that
  // created the project folder finds it already there (`created` undefined) but its entry in
  // project-sources/ (and that one's in the workspace) may never have been fsynced.
  if (pendingDirs) addChain(wsDir, dir, dirs);
  if (!pendingDirs) flushDirs(dirs);
  cache.delete(file);
  written(wsDir, projectId, ref);
}

/** Adds `dir` and every folder above it up to and including `wsDir` to `dirs`. */
function addChain(wsDir, dir, dirs) {
  const top = path.resolve(wsDir);
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    dirs.add(d);
    if (d === top || d === path.dirname(d)) break;
  }
}

// #1819: a write generation per text key, so a background scan that started before a write never
// flags the text that write just put back.
const generation = new Map();
/** #1818: written again (a re-upload, a refresh): no longer missing, and any scan in flight is stale. */
function written(wsDir, projectId, ref) {
  const key = missingKey(wsDir, projectId, ref);
  generation.set(key, (generation.get(key) || 0) + 1);
  unreadable.delete(key);
}

/** fsyncs each folder of `dirs` once, deepest first (a new folder's entries before its parent's
 *  entry for it), then empties the set. */
function flushDirs(dirs) {
  for (const d of [...dirs].sort((a, b) => b.length - a.length)) fsyncPath(d);
  dirs.clear();
}

const isAccessor = (f) => { const d = Object.getOwnPropertyDescriptor(f, 'content'); return !!d && typeof d.get === 'function'; };
/** Whether `f` is a source whose text is in its file (not changed since it was last saved). */
const isExternal = (f) => !!f && typeof f === 'object' && REF.test(String(f.textRef)) && isAccessor(f);
/** The text's length without reading it when it is in its file. */
const textLength = (f) => (isExternal(f) && Number.isSafeInteger(f.chars) ? f.chars : String((f && f.content) || '').length);
/** Whether two sources hold the same text, comparing pointers when both are in their files. */
const sameText = (a, b) => (isExternal(a) && isExternal(b) ? a.textRef === b.textRef : String(a?.content ?? '') === String(b?.content ?? ''));

function toJSON() {
  const out = {};
  const skip = isAccessor(this);
  for (const k of Object.keys(this)) if (!(skip && k === 'content')) out[k] = this[k];
  return out;
}

const origin = new WeakMap();

/** A deep copy of a source that still reads its text on demand (structuredClone would read it). */
function cloneFile(file) {
  const from = isExternal(file) && origin.get(file);
  if (!from) return structuredClone(file);
  const copy = structuredClone(toJSON.call(file));
  attachFile(copy, from.wsDir, from.projectId);
  return copy;
}

/** Gives `file` (with a textRef and no content) its content accessor and toJSON. Idempotent. */
function attachFile(file, wsDir, projectId) {
  if (!file || typeof file !== 'object' || !REF.test(String(file.textRef))) return;
  if (Object.getOwnPropertyDescriptor(file, 'content')) {
    if (!Object.getOwnPropertyDescriptor(file, 'toJSON')) Object.defineProperty(file, 'toJSON', { value: toJSON, enumerable: false, configurable: true, writable: true });
    return;
  }
  const ref = file.textRef;
  origin.set(file, { wsDir, projectId });
  Object.defineProperty(file, 'content', {
    enumerable: true, configurable: true,
    get() { return readText(wsDir, projectId, ref); },
    set(value) { Object.defineProperty(this, 'content', { value, enumerable: true, configurable: true, writable: true }); },
  });
  if (!Object.getOwnPropertyDescriptor(file, 'toJSON')) Object.defineProperty(file, 'toJSON', { value: toJSON, enumerable: false, configurable: true, writable: true });
}

const filesOf = (project) => (project && typeof project === 'object' && Array.isArray(project.files) ? project.files : []);

function attachAll(wsDir, projects) {
  for (const p of projects || []) for (const f of filesOf(p)) attachFile(f, wsDir, p.id);
}

/** Moves every plain string `content` to its file (written first), leaving the pointer. Returns
 *  how many sources moved. */
function externalize(wsDir, projects) {
  // #1815: every text file is written (and its data fsynced) first; each folder is fsynced once at
  // the end, before this returns, so before the caller writes projects.json.
  // #1818: a source is switched to its pointer in memory only after that fsync. If a write or a
  // fsync throws (ENOSPC, EIO), no source of this call has been switched: each still holds its text
  // as a plain value, so no projects.json (this save aborts; a later one runs externalize again)
  // can carry a pointer whose folder entry was not made durable. A retry finds the file already
  // there and fsyncs its folder again (writeText) before switching.
  const pendingDirs = new Set();
  const done = [];
  for (const p of projects || []) {
    if (!p || typeof p.id !== 'string') continue;
    for (const f of filesOf(p)) {
      if (!f || typeof f !== 'object') continue;
      const d = Object.getOwnPropertyDescriptor(f, 'content');
      if (!d || !('value' in d) || typeof d.value !== 'string') continue;
      const text = d.value;
      if (text === '' && REF.test(String(f.textRef)) && unreadable.has(missingKey(wsDir, p.id, f.textRef))) {
        // A copy of a source whose text could not be read: keep its pointer, never save '' over it.
        delete f.content;
        attachFile(f, wsDir, p.id);
        continue;
      }
      const ref = refOf(text);
      writeText(wsDir, p.id, ref, text, pendingDirs);
      done.push([f, p.id, ref, text]);
    }
  }
  flushDirs(pendingDirs);
  for (const [f, projectId, ref, text] of done) {
    // A handler may have changed the text again meanwhile only if it ran in between; nothing awaits
    // here, so `f.content` is still `text`.
    delete f.content;
    f.textRef = ref;
    f.chars = text.length;
    if (headerNamesSkill(text)) f.skillHeader = true; else delete f.skillHeader;
    attachFile(f, wsDir, projectId);
  }
  return done.length;
}

/** Removes text files no source of `projects` points at, and the folders of projects that are gone. */
// A text file no source points at is removed only once it has stayed unreferenced for GRACE_MS
// across saves: a handler that awaited (a folder sync, an upload) may still hold a source object
// pointing at it and put that back in the list. #1815: 24 hours (a long folder sync with document
// conversion can hold sources for a long time; the disk cost of keeping a text a day is negligible),
// and no collection at all while a folder import or attached-folder sync runs in that workspace.
const GRACE_MS = 24 * 60 * 60 * 1000;
let graceDefault = GRACE_MS;
const unreferencedSince = new Map();

// #1815: folder imports and attached-folder syncs in flight, per workspace folder (this process).
const inFlight = new Map();
const wsKey = (wsDir) => path.resolve(String(wsDir));
/** Registers source work in flight for `wsDir`; returns the function that ends it (idempotent). */
function beginSourceWork(wsDir) {
  const key = wsKey(wsDir);
  inFlight.set(key, (inFlight.get(key) || 0) + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const n = (inFlight.get(key) || 1) - 1;
    if (n > 0) inFlight.set(key, n); else inFlight.delete(key);
  };
}
/** Runs `fn` with source work registered for `wsDir` (no registration when `wsDir` is falsy). */
async function whileSourceWork(wsDir, fn) {
  if (!wsDir) return fn();
  const end = beginSourceWork(wsDir);
  try { return await fn(); } finally { end(); }
}
const sourceWorkInFlight = (wsDir) => (inFlight.get(wsKey(wsDir)) || 0) > 0;

function collect(wsDir, projects, { now = Date.now(), graceMs = graceDefault } = {}) {
  if (sourceWorkInFlight(wsDir)) return;
  const root = path.join(wsDir, DIR);
  let dirs;
  try { dirs = fs.readdirSync(root); } catch { return; }
  const live = new Map();
  for (const p of projects || []) {
    if (!p || typeof p.id !== 'string') continue;
    const key = safeId(p.id);
    const refs = live.get(key) || new Set();
    for (const f of filesOf(p)) if (f && REF.test(String(f.textRef))) refs.add(f.textRef);
    live.set(key, refs);
  }
  for (const d of dirs) {
    const dir = path.join(root, d);
    const refs = live.get(d);
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    let left = names.length;
    for (const n of names) {
      const full = path.join(dir, n);
      const ref = n.endsWith('.txt') ? n.slice(0, -4) : null;
      if (ref && refs && refs.has(ref)) { unreferencedSince.delete(full); continue; }
      let since = unreferencedSince.get(full);
      if (since === undefined) { since = now; unreferencedSince.set(full, now); }
      if (now - since < graceMs) continue;
      fs.rmSync(full, { force: true });
      unreferencedSince.delete(full);
      if (ref) unreadable.delete(missingKey(wsDir, d, ref)); // #1818: gone on purpose, nothing to flag
      left -= 1;
    }
    if (!refs && left === 0) {
      fs.rmSync(dir, { recursive: true, force: true });
      // #1819: the project's folder is gone: nothing under it can be reported missing any more.
      const prefix = missingKey(wsDir, d, '');
      for (const k of [...unreadable]) if (k.startsWith(prefix)) unreadable.delete(k);
      for (const k of [...generation.keys()]) if (k.startsWith(prefix)) generation.delete(k);
    }
  }
}

const hasInline = (projects) => (projects || []).some((p) => filesOf(p).some((f) => {
  const d = f && typeof f === 'object' && Object.getOwnPropertyDescriptor(f, 'content');
  return !!d && 'value' in d && typeof d.value === 'string';
}));

/** The backup migrateOnLoad keeps (see the header), or null when there is no projects.json. */
function backupProjectsFile(wsDir) {
  const file = path.join(wsDir, 'projects.json');
  let bytes;
  try { bytes = fs.readFileSync(file); } catch { return null; }
  const dir = path.join(wsDir, 'migration-backups');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = path.join(dir, `projects-pre-1806-${crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16)}.json`);
  if (!fs.existsSync(target)) {
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, bytes, { mode: 0o600 });
    fs.renameSync(tmp, target);
  }
  return target;
}

/** Called once per workspace load: true when inline text was found (and backed up and moved);
 *  the caller then saves projects.json. */
function migrateOnLoad(wsDir, projects) {
  if (!hasInline(projects)) { attachAll(wsDir, projects); return false; }
  const backup = backupProjectsFile(wsDir);
  const moved = externalize(wsDir, projects);
  attachAll(wsDir, projects);
  console.log(`[sources] moved the text of ${moved} source(s) out of projects.json (#1806); backup: ${backup ? path.basename(backup) : 'none'}`);
  return true;
}

/** #1815: whether `file` points at a text file that is gone or cannot be read, checked on the file
 *  itself now (one sync call; used by the sources/text route). Its pointer is kept (nothing is
 *  dropped or rewritten); this only reports it. A source with inline text is never missing. */
function textMissingNow(file) {
  if (!isExternal(file)) return false;
  const from = origin.get(file);
  if (!from) return false;
  const full = path.join(projectDir(from.wsDir, from.projectId), `${file.textRef}.txt`);
  const key = missingKey(from.wsDir, from.projectId, file.textRef);
  // The file itself is checked even when its text is cached: a cached copy must not hide a deletion.
  try { fs.accessSync(full, fs.constants.R_OK); }
  catch { unreadable.add(key); if (cache.has(full)) { cached -= cache.get(full).length; cache.delete(full); } return true; }
  // Readable now; one that failed before (a restore since) is read once to be sure, which clears it.
  if (unreadable.has(key)) { readText(from.wsDir, from.projectId, file.textRef); return unreadable.has(key); }
  return false;
}

// #1818: the list (GET /api/workspace) never touches the disk per source. It reports what is known:
// the `unreadable` set, filled when a read fails and by a background async scan of the sources a
// list showed, run on the first list of a workspace and then at most every SCAN_MS; cleared when a
// text is written again, read again, or collected. Unknown (not scanned yet) is not flagged.
const SCAN_MS = 3 * 60 * 1000;
let scanMs = SCAN_MS;
const scans = new Map(); // workspace -> { at, running: Promise|null, seen: Map<key, [full, cacheKey]> }
const pendingScans = new Set();

/** Remembers `full` for the workspace's next scan, and starts one (async, after this tick) when due. */
function noteForScan(wsDir, key, full) {
  const ws = wsKey(wsDir);
  let st = scans.get(ws);
  if (!st) { st = { at: -Infinity, running: null, seen: new Map() }; scans.set(ws, st); }
  if (st.running || Date.now() - st.at < scanMs) return;
  st.seen.set(key, full);
  if (pendingScans.has(ws)) return;
  pendingScans.add(ws);
  setImmediate(() => {
    pendingScans.delete(ws);
    const batch = st.seen; st.seen = new Map();
    st.at = Date.now();
    st.running = (async () => {
      for (const [k, f] of batch) {
        const gen = generation.get(k) || 0;
        try { await fs.promises.access(f, fs.constants.R_OK); unreadable.delete(k); }
        catch (e) {
          // A write since the check started (a re-upload) wins: its file is there now.
          if ((generation.get(k) || 0) !== gen) continue;
          if (e && (e.code === 'ENOENT' || e.code === 'EACCES' || e.code === 'ENOTDIR' || e.code === 'EPERM')) {
            unreadable.add(k);
            if (cache.has(f)) { cached -= cache.get(f).length; cache.delete(f); }
          }
        }
      }
    })().catch(() => {}).finally(() => { st.running = null; });
  });
}

/** Whether `file`'s text is known to be missing, without any filesystem call (the list's check). */
function textMissing(file) {
  if (!isExternal(file)) return false;
  const from = origin.get(file);
  if (!from) return false;
  const key = missingKey(from.wsDir, from.projectId, file.textRef);
  noteForScan(from.wsDir, key, path.join(projectDir(from.wsDir, from.projectId), `${file.textRef}.txt`));
  return unreadable.has(key);
}

/** Resolves when the workspace's scan (started or about to start) is done. For tests. */
async function scanSettled(wsDir) {
  await new Promise((r) => setImmediate(r));
  const st = scans.get(wsKey(wsDir));
  if (st && st.running) await st.running;
}

/** A source as the client gets it in a list: metadata only, never the text; `textMissing: true`
 *  when its text file is gone or unreadable (#1815). */
function meta(file) {
  if (!file || typeof file !== 'object') return file;
  const out = {};
  for (const k of Object.keys(file)) if (k !== 'content' && k !== 'textMissing') out[k] = file[k];
  if (!REF.test(String(out.textRef)) && typeof file.content === 'string') out.chars = file.content.length;
  if (textMissing(file)) out.textMissing = true;
  return out;
}

/** Rollback (see the header): projects.json with every text back inline. Server stopped. */
function inlineAll(wsDir, { lock = require('./rust-projects.cjs').withFileLock } = {}) {
  const file = path.join(wsDir, 'projects.json');
  let n = 0;
  // Under the same flock as every projects.json writer (rust-projects.cjs), in case a writer is
  // still running despite the instructions (stop Node and the Rust front first).
  lock(file, () => {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Every text is read, strictly, before anything is written: one missing, unreadable or
    // mismatched file aborts the run with projects.json and the backups untouched.
    const texts = [];
    for (const p of data.projects || []) for (const f of filesOf(p)) {
      if (!f || f.textRef === undefined) continue;
      try { texts.push([f, readTextStrict(wsDir, p.id, f.textRef)]); }
      catch (e) { throw Object.assign(new Error(`rollback aborted, nothing written: the text of "${f.name}" in project ${p.id} cannot be read (${e.code || ''} ${e.message})`), { code: 'ROLLBACK_ABORTED' }); }
    }
    backupProjectsFile(wsDir);
    for (const [f, text] of texts) { f.content = text; delete f.textRef; delete f.chars; delete f.skillHeader; n += 1; }
    const tmp = `${file}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeSync(fd, JSON.stringify(data, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
    fsyncPath(wsDir);
  });
  return n;
}

if (require.main === module) {
  const [cmd, dir] = process.argv.slice(2);
  if (cmd !== 'inline' || !dir) { console.error('usage: node server/source-text.cjs inline <workspace dir>'); process.exit(2); }
  console.log(`inlined ${inlineAll(path.resolve(dir))} source text(s) into ${path.join(dir, 'projects.json')}`);
}

module.exports = {
  DIR, refOf, projectDir, readText, readTextStrict, writeText, attachFile, attachAll, externalize, collect, migrateOnLoad,
  hasInline, isExternal, textLength, cloneFile, sameText, meta, inlineAll, headerNamesSkill,
  textMissing, textMissingNow, scanSettled, SCAN_MS, _setScanMs(ms) { scanMs = ms; }, beginSourceWork, whileSourceWork, sourceWorkInFlight, flushDirs,
  _cache: { clear() { cache.clear(); cached = 0; warned.clear(); unreadable.clear(); unreferencedSince.clear(); inFlight.clear(); scans.clear(); pendingScans.clear(); generation.clear(); scanMs = SCAN_MS; } }, GRACE_MS, _setGraceMs(ms) { graceDefault = ms; },
};
