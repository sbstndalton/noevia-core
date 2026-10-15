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
// empty (it keeps the textRef fields it does not know). To go back, stop the server and either
//   node server/source-text.cjs inline <workspace dir>
// which writes the text back into projects.json (after its own backup), or restore the newest
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
function readText(wsDir, projectId, ref) {
  if (!REF.test(String(ref))) return '';
  const file = path.join(projectDir(wsDir, projectId), `${ref}.txt`);
  const hit = cache.get(file);
  if (hit !== undefined) { cache.delete(file); cache.set(file, hit); return hit; }
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (e) {
    if (!warned.has(file)) { warned.add(file); console.warn(`[sources] text of a source is missing (${e.code || e.message}); it reads as empty`); }
    return '';
  }
  remember(file, text);
  return text;
}

function writeText(wsDir, projectId, ref, text) {
  const dir = projectDir(wsDir, projectId);
  const file = path.join(dir, `${ref}.txt`);
  if (fs.existsSync(file)) return;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
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
  let moved = 0;
  for (const p of projects || []) {
    if (!p || typeof p.id !== 'string') continue;
    for (const f of filesOf(p)) {
      if (!f || typeof f !== 'object') continue;
      const d = Object.getOwnPropertyDescriptor(f, 'content');
      if (!d || !('value' in d) || typeof d.value !== 'string') continue;
      const text = d.value;
      const ref = refOf(text);
      writeText(wsDir, p.id, ref, text);
      delete f.content;
      f.textRef = ref;
      f.chars = text.length;
      if (headerNamesSkill(text)) f.skillHeader = true; else delete f.skillHeader;
      attachFile(f, wsDir, p.id);
      moved += 1;
    }
  }
  return moved;
}

/** Removes text files no source of `projects` points at, and the folders of projects that are gone. */
function collect(wsDir, projects) {
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
    if (!refs) { fs.rmSync(dir, { recursive: true, force: true }); continue; }
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      const ref = n.endsWith('.txt') ? n.slice(0, -4) : null;
      if (ref && refs.has(ref)) continue;
      fs.rmSync(path.join(dir, n), { force: true });
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

/** A source as the client gets it in a list: metadata only, never the text. */
function meta(file) {
  if (!file || typeof file !== 'object') return file;
  const out = {};
  for (const k of Object.keys(file)) if (k !== 'content') out[k] = file[k];
  if (!REF.test(String(out.textRef)) && typeof file.content === 'string') out.chars = file.content.length;
  return out;
}

/** Rollback (see the header): projects.json with every text back inline. Server stopped. */
function inlineAll(wsDir) {
  const file = path.join(wsDir, 'projects.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  backupProjectsFile(wsDir);
  let n = 0;
  for (const p of data.projects || []) for (const f of filesOf(p)) {
    if (!f || !REF.test(String(f.textRef))) continue;
    f.content = readText(wsDir, p.id, f.textRef);
    delete f.textRef; delete f.chars; delete f.skillHeader;
    n += 1;
  }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return n;
}

if (require.main === module) {
  const [cmd, dir] = process.argv.slice(2);
  if (cmd !== 'inline' || !dir) { console.error('usage: node server/source-text.cjs inline <workspace dir>'); process.exit(2); }
  console.log(`inlined ${inlineAll(path.resolve(dir))} source text(s) into ${path.join(dir, 'projects.json')}`);
}

module.exports = {
  DIR, refOf, projectDir, readText, writeText, attachFile, attachAll, externalize, collect, migrateOnLoad,
  hasInline, isExternal, textLength, cloneFile, sameText, meta, inlineAll, headerNamesSkill,
  _cache: { clear() { cache.clear(); cached = 0; warned.clear(); } },
};
