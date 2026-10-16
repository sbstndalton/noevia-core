'use strict';
// M4 of the full-Rust migration (noevia docs/adr-0001-rust-and-repo-split.md, "Amendment
// 2026-10-10"): the Rust front (noevia-rs bins/noevia-server, crates/server-projects) takes over
// project routes slice by slice. The first slice is a project's image assets
// (POST /api/projects/{id}/assets, GET and DELETE /api/projects/{id}/assets/{assetId}); the second
// its chat list (GET and POST /api/projects/{id}/chats); the third the free-chat list (GET and POST
// /api/freechats; DELETE /api/freechats/{id} stays Node's, see "free-chats.json" below).
//
// The switch is NOEVIA_RUST_PROJECTS=1 (exactly) together with NOEVIA_FRONT=rust, the M3 switch
// (NOEVIA_RUST_AUTH=1, confirmed: the front gates Rust-owned routes itself) and the supervisor's
// NOEVIA_RUST_PROJECTS_CONFIRMED=1 (set only once the front's --features lists rust-projects).
// Anything less and the switch is ignored here (a warning is printed) and Node keeps doing
// everything, as before. Each slice after the first is confirmed on its own, because a front that
// lists rust-projects may predate it: the chat-list save is refused here only with
// NOEVIA_RUST_PROJECT_CHATS_CONFIRMED=1 as well (set only once the front's --features lists
// rust-project-chats; chatsEnabledFrom). Without it a front that answers only the images forwards
// the chat-list save here, and Node keeps answering it (sbstndalton/noevia#1409). The free-chat
// list likewise needs NOEVIA_RUST_FREE_CHATS_CONFIRMED=1 (the front lists rust-free-chats;
// freeChatsEnabledFrom).
//
// projects.json cannot have one writer yet: Node's other routes (the chat turn, a chat's move or
// delete, the config route) still change it. So while the switch is on, both processes write it only under one shared lock and
// never from a stale copy:
//
//   - the lock is an OS advisory lock, flock(2) LOCK_EX, on `projects.json.lock` beside the file
//     (mode 0600), created once and never unlinked: unlinking would let two writers lock two
//     different inodes. flock and fcntl locks do not interoperate on Linux, so both sides use
//     flock: Rust through std's File::try_lock, Node (no flock in node:fs, no native addon) through
//     util-linux flock(1) run on an inherited descriptor: flock belongs to the open file
//     description, so the lock the child takes stays held by this process's descriptor after the
//     child exits, until it is closed. A holder that dies releases it with its descriptors: no
//     staleness rule. A writer waits up to LOCK_WAIT_MS, then answers 503 PROJECTS_BUSY. Holds
//     are one read-modify-write, a few milliseconds. noevia-rs crates/server-projects `lock` is
//     the other half; keep LOCK_SUFFIX and LOCK_WAIT_MS equal.
//   - Rust re-reads the file under the lock and changes only the project it serves.
//   - Node keeps its cached workspace, but a save is a three-way merge under the lock: the
//     projects this process changed, added or removed since it last read the file are applied to
//     what is on disk now; every other project is taken from disk. A project both sides changed
//     between two reads is merged per top-level field (this process's value where it changed the
//     field), so a chat save does not drop an image Rust added meanwhile. The id-keyed lists
//     (assets, retiredAssets, chats) are merged per item: additions from both sides, removals since
//     the base from either side, an item both changed merged per field like a project (#1801: a
//     title saved here keeps the updatedAt and preview the front saved meanwhile; a chat meta the
//     front saved survives a move or delete of another chat here, and a delete here is not undone). Any other field
//     changed on both sides is last-writer-wins. Every request start re-reads the file
//     when its (ino, size, mtime) changed, refreshing unchanged projects in place, so a handler
//     holding a project object still sees the current one.
//   - Node's copies of the Rust-owned write routes answer 503 RUST_PROJECTS_OWNED (refuseOwned),
//     so a request that reaches Node directly cannot write behind the front's back. The reads stay.
//
// free-chats.json (the free-chat slice) has the same problem and the same answer: Node's chat turn
// (the routing flags), a chat's move, a free chat's delete, the retention sweep and an import still
// write it. While the slice is on, both processes write it only under `free-chats.json.lock` (the
// same flock and wait). Rust re-reads it under the lock for every save. Node keeps its cached list,
// re-reads it at each request start when its (ino, size, mtime) changed, and saves under the lock:
// when the file still holds what this process last read or wrote, its list as it is; otherwise
// the chat metas are merged per item against that base (mergeIdList: additions from both sides,
// removals since the base from either side, a meta both changed merged per field, #1801), newest first
// as mergeChats orders them, at most LIST_CAP. A file that is not a JSON array on either side is
// not merged: the other side's value is taken (refresh) or replaced (save), as before.
// DELETE /api/freechats/{id} stays Node's: it also removes the chat's transcript, context meter,
// brain note and attachments project (a whole project delete, with its RAG index and storage
// sweep), which the front does not do yet.
//
// Project writes (sbstndalton/noevia#1264): the rest of Node's projects.json and free-chats.json
// writers move to the front slice by slice, each behind a second switch, NOEVIA_RUST_PROJECT_WRITES=1
// (off by default; NOEVIA_RUST_PROJECTS=1 alone never moves them), confirmed by the supervisor only
// for a front whose --features lists rust-project-writes (NOEVIA_RUST_PROJECT_WRITES_CONFIRMED=1):
// projectWritesEnabledFrom. PROJECT_WRITE_ROUTES lists them (noevia-rs contracts/http/routes.toml,
// switch = "NOEVIA_RUST_PROJECT_WRITES"); Node's copies refuse them (refuseOwned) while it is on.
// Slice 1: a free chat's attachments project, GET and POST /api/chats/{chatId}/context (GET too:
// getProject's self-heal writes).
//
// Removed, with Node's copies of the routes, once Rust owns every projects.json and
// free-chats.json writer.

const fs = require('fs');
const { spawnSync } = require('child_process');

const LOCK_SUFFIX = '.lock';
const LOCK_WAIT_MS = 3000;
// flock(1)'s exit status when -w ran out (-E); anything else non-zero is a failure, not "busy".
const FLOCK_BUSY_STATUS = 75;

/** The routes a Rust front can answer under the switch: METHOD path-pattern. noevia-rs
 *  contracts/http/routes.toml (switch = "NOEVIA_RUST_PROJECTS") is the other half; noevia's
 *  deploy/tools/assemble-release.sh refuses a release whose front owns a project route missing
 *  here. The chat-list routes are the front's only with chatsEnabledFrom, the free-chat routes
 *  only with freeChatsEnabledFrom. */
const OWNED_ROUTES = Object.freeze(new Set([
  'POST /api/projects/{id}/assets',
  'GET /api/projects/{id}/assets/{assetId}',
  'DELETE /api/projects/{id}/assets/{assetId}',
  'GET /api/projects/{id}/chats',
  'POST /api/projects/{id}/chats',
  'GET /api/freechats',
  'POST /api/freechats',
]));

/** The project writes the Rust front answers under NOEVIA_RUST_PROJECT_WRITES (see the header):
 *  METHOD path-pattern, as OWNED_ROUTES. noevia's deploy/tools/assemble-release.sh refuses a
 *  release whose front owns a route under that switch missing here. */
const PROJECT_WRITE_ROUTES = Object.freeze(new Set([
  'GET /api/chats/{chatId}/context',
  'POST /api/chats/{chatId}/context',
]));

/** Whether the switch is on for this process (see the header). */
function enabledFrom(env = process.env, warn = console.warn) {
  if (env.NOEVIA_RUST_PROJECTS !== '1') return false;
  if (env.NOEVIA_FRONT !== 'rust') {
    warn('NOEVIA_RUST_PROJECTS=1 is ignored: the Rust front answers project routes only with NOEVIA_FRONT=rust.');
    return false;
  }
  if (env.NOEVIA_RUST_AUTH !== '1' || env.NOEVIA_RUST_AUTH_CONFIRMED !== '1') {
    warn('NOEVIA_RUST_PROJECTS=1 is ignored: it needs NOEVIA_RUST_AUTH=1, confirmed, because the front gates the routes it owns itself.');
    return false;
  }
  if (env.NOEVIA_RUST_PROJECTS_CONFIRMED !== '1') {
    warn('NOEVIA_RUST_PROJECTS=1 is ignored: the supervisor has not confirmed that the Rust front supports rust-projects (NOEVIA_RUST_PROJECTS_CONFIRMED).');
    return false;
  }
  return true;
}

function busy() {
  return Object.assign(new Error('The project store is busy. Try again shortly.'), { status: 503, code: 'PROJECTS_BUSY' });
}

/** Runs `fn` (synchronously) holding flock(LOCK_EX) on `<file>.lock` (see the header). Throws
 *  503 PROJECTS_BUSY after LOCK_WAIT_MS. `flockBin`: tests. */
function withFileLock(file, fn, { flockBin = 'flock' } = {}) {
  const fd = fs.openSync(file + LOCK_SUFFIX, fs.constants.O_RDWR | fs.constants.O_CREAT, 0o600);
  try {
    const r = spawnSync(flockBin, ['-x', '-w', String(LOCK_WAIT_MS / 1000), '-E', String(FLOCK_BUSY_STATUS), '3'], {
      stdio: ['ignore', 'ignore', 'pipe', fd],
    });
    if (r.error) {
      if (r.error.code === 'ENOENT') throw Object.assign(new Error('NOEVIA_RUST_PROJECTS needs flock(1) (util-linux) on PATH to lock projects.json'), { status: 500, code: 'PROJECTS_LOCK_UNAVAILABLE' });
      throw r.error;
    }
    if (r.status === FLOCK_BUSY_STATUS) throw busy();
    if (r.status !== 0) throw new Error(`flock(1) failed (status ${r.status}${r.signal ? ', ' + r.signal : ''}): ${String(r.stderr || '').trim()}`);
    return fn();
  } finally {
    fs.closeSync(fd); // releases the lock (the child's copy closed when it exited)
  }
}

const idOf = (p) => (p && typeof p === 'object' && typeof p.id === 'string' ? p.id : null);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const blank = (v) => v === undefined || (Array.isArray(v) ? v.length === 0 : v !== null && typeof v === 'object' && Object.keys(v).length === 0);
// Node normalises absent lists in memory after a save (uploads.prune: `project.assets =
// (project.assets || []).filter(...)` runs after the config route's save). An absent field turned
// into an empty list or object is not a change of this process's: it must not erase what the
// other writer put in that field meanwhile.
const unchangedHere = (o, b) => same(o, b) || (b === undefined && blank(o));

// Lists of `{ id, ... }` merged per item rather than as one value (see the header).
const ID_LISTS = new Set(['assets', 'retiredAssets', 'chats']);
const listOrNull = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : null);

/** The id-keyed three-way merge of one list: disk order, items new here appended. An item removed
 *  since `base` on either side is gone (even if the other side changed it); one added on either
 *  side is kept; one both have is the disk's unless this process changed it, and one both changed
 *  is merged per field (mergeFields, #1801). Items without a string id are the disk's. */
function mergeIdList(ours, base, theirs) {
  const map = (l) => { const m = new Map(); for (const x of l) { const id = idOf(x); if (id !== null && !m.has(id)) m.set(id, x); } return m; };
  const o = map(ours); const b = map(base);
  const out = []; const placed = new Set();
  for (const t of theirs) {
    const id = idOf(t);
    if (id === null) { out.push(t); continue; }
    if (placed.has(id)) continue;
    placed.add(id);
    if (!o.has(id)) { if (!b.has(id)) out.push(t); continue; } // added there / removed here
    const mine = o.get(id);
    if (!b.has(id)) { out.push(mine); continue; } // added on both sides: this process's
    if (same(mine, b.get(id))) { out.push(t); continue; } // changed only there (or not at all)
    // #1801: changed on both sides: per field, this process's value where it changed the field and
    // the disk's otherwise, so a generated title saved here keeps the updatedAt and preview the
    // front saved meanwhile. Non-object items stay this process's.
    out.push(plain(mine) && plain(t) && plain(b.get(id)) ? mergeFields(mine, JSON.stringify(b.get(id)), t) : mine);
  }
  for (const x of ours) {
    const id = idOf(x);
    if (id === null || placed.has(id)) continue;
    placed.add(id);
    if (!b.has(id)) out.push(x); // new here; in base and not on disk: removed there
  }
  return out;
}

/** One project both sides changed since the last read: per top-level field, this process's value
 *  where it changed the field, the disk's otherwise (disk key order, new local fields appended);
 *  ID_LISTS per item (mergeIdList). */
function mergeFields(ours, baseJson, theirs) {
  let base;
  try { base = JSON.parse(baseJson); } catch { base = {}; }
  if (!base || typeof base !== 'object') base = {};
  const out = {};
  const list = (k) => {
    if (!ID_LISTS.has(k)) return undefined;
    const o = listOrNull(ours[k]); const b = listOrNull(base[k]); const t = listOrNull(theirs[k]);
    if (o === null || b === null || t === null) return undefined; // not lists: the general rule
    const merged = mergeIdList(o, b, t);
    // Empty: kept as a field only where a side still has it (Node deletes an empty retiredAssets).
    if (!merged.length && !Array.isArray(ours[k]) && !(Array.isArray(theirs[k]) && unchangedHere(ours[k], base[k]))) return { omit: true };
    return { value: merged };
  };
  for (const k of Object.keys(theirs)) {
    const l = list(k);
    if (l) { if (!l.omit) out[k] = l.value; }
    else if (unchangedHere(ours[k], base[k])) out[k] = theirs[k];
    else if (own(ours, k) && ours[k] !== undefined) out[k] = ours[k];
    // removed here: left out
  }
  for (const k of Object.keys(ours)) {
    if (own(out, k) || own(theirs, k)) continue;
    const l = list(k);
    if (l) { if (!l.omit) out[k] = l.value; }
    else if (!same(ours[k], base[k])) out[k] = ours[k];
  }
  return out;
}

/**
 * The three-way merge. `local` is this process's view, `base` maps id -> JSON.stringify of each
 * project as last read from (or written to) disk, `disk` is the file's projects now. Returns the
 * merged list (disk order; projects new here keep their place relative to their local neighbours)
 * and `adopt`: id -> the entry that replaces this process's object for that id (taken from disk,
 * or field-merged).
 *
 * Changed only here: local. Changed only on disk: disk. Changed on both: mergeFields. Removed
 * here (in base, not local): gone, even if changed on disk. Removed on disk while held here
 * unchanged: gone. New here (not in base): kept, unless disk already has that id (then as changed
 * on both). Entries without a string id are taken from disk only.
 */
function merge(local, base, disk) {
  const mine = new Map();
  for (const p of local) { const id = idOf(p); if (id !== null && !mine.has(id)) mine.set(id, p); }
  const result = [];
  const adopt = new Map();
  const placed = new Set();
  for (const d of disk) {
    const id = idOf(d);
    if (id === null) { result.push(d); continue; }
    if (placed.has(id)) continue;
    placed.add(id);
    const ours = mine.get(id);
    if (!ours) {
      if (base.has(id)) { placed.delete(id); continue; } // removed here
      result.push(d); adopt.set(id, d); continue;
    }
    const baseJson = base.get(id);
    const changedHere = baseJson === undefined || JSON.stringify(ours) !== baseJson;
    const changedThere = baseJson === undefined || JSON.stringify(d) !== baseJson;
    if (!changedHere) { result.push(d); adopt.set(id, d); }
    else if (!changedThere) result.push(ours);
    else { const merged = mergeFields(ours, baseJson === undefined ? '{}' : baseJson, d); result.push(merged); adopt.set(id, merged); }
  }
  // New here: after the nearest earlier local project that is placed, else first.
  let prev = null;
  for (const p of local) {
    const id = idOf(p);
    if (id === null) continue;
    if (placed.has(id)) { prev = id; continue; }
    if (base.has(id)) continue; // removed on disk by the other writer: stays removed
    const at = prev === null ? 0 : result.findIndex((q) => idOf(q) === prev) + 1;
    result.splice(at, 0, p);
    placed.add(id);
    prev = id;
  }
  return { result, adopt };
}

/** Replaces `target`'s own properties with `source`'s, keeping the object (and its key order = source's). */
function replaceContents(target, source) {
  for (const k of Object.keys(target)) delete target[k];
  Object.assign(target, source);
  return target;
}

/** (ino, size, mtime) of a file or null when it is missing. */
function stampOf(st) { return st ? `${st.ino}:${st.size}:${st.mtimeMs}` : null; }
function statOrNull(file) {
  try { return fs.statSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

/** The file's projects and stamp, read through one descriptor; `projects` is null when the file is
 *  missing (an empty list) or unreadable as Node's `{ projects: [...] }` (`corrupt` set). */
function readProjectsFile(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch (e) { if (e.code === 'ENOENT') return { projects: [], stamp: null, corrupt: false }; throw e; }
  try {
    const stamp = stampOf(fs.fstatSync(fd));
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(fd, 'utf8')); } catch { return { projects: null, stamp, corrupt: true }; }
    const projects = parsed && typeof parsed === 'object' ? parsed.projects : undefined;
    if (projects === undefined || projects === null) return { projects: [], stamp, corrupt: false };
    if (!Array.isArray(projects)) return { projects: null, stamp, corrupt: true };
    return { projects, stamp, corrupt: false };
  } finally { fs.closeSync(fd); }
}

/**
 * The coordinated projects.json of one workspace while the switch is on (see the header). The
 * workspace calls load() once, refresh(projects) at each request start and save(projects) for
 * saveProjects; the array is updated in place.
 */
/** The file's stamp when it still holds exactly `text` (what this process just had the store
 *  write), so the next request start does not take its own save for the other writer's; else null
 *  (re-read). Node only reads the file here. */
function stampIfStill(file, text) {
  try {
    const fd = fs.openSync(file, 'r');
    try { const st = fs.fstatSync(fd); return fs.readFileSync(fd, 'utf8') === text ? stampOf(st) : null; } finally { fs.closeSync(fd); }
  } catch { return null; }
}

/** projects.json text as Node's atomicJson writes it. */
const projectsText = (projects) => JSON.stringify({ projects }, null, 2);

/** The store's text of projects.json as readProjectsFile reads the file: `{ projects }` or corrupt. */
function parseProjectsText(text) {
  if (text === null) return { projects: [], corrupt: false };
  try {
    const v = JSON.parse(text);
    if (v && typeof v === 'object' && !Array.isArray(v) && (v.projects === undefined || v.projects === null)) return { projects: [], corrupt: false };
    if (v && Array.isArray(v.projects)) return { projects: v.projects, corrupt: false };
  } catch { /* corrupt */ }
  return { projects: null, corrupt: true };
}

/** `remote` (#1264, project-store-client.cjs): { client, user, queue }. Given, save() writes
 *  through the Rust store (a compare-and-swap, async, no flock) and returns a promise; without
 *  it, the flock path below, unchanged. */
function createProjectsFile(file, { atomicJson, warn = console.warn, lock = withFileLock, remote = null } = {}) {
  const state = { base: new Map(), stamp: null };
  const byId = (list) => { const m = new Map(); for (const p of list) { const id = idOf(p); if (id !== null && !m.has(id)) m.set(id, p); } return m; };

  function rebase(list) {
    state.base = new Map();
    for (const [id, p] of byId(list)) state.base.set(id, JSON.stringify(p));
  }

  /** Puts `result` into the workspace array in place; an adopted entry is copied into the object
   *  this process already holds for that id, so a handler holding it sees the current project. */
  function apply(localArray, result, adopt) {
    const held = byId(localArray);
    const next = result.map((p) => {
      const id = idOf(p);
      const h = id === null ? undefined : held.get(id);
      return h && adopt.has(id) && h !== p ? replaceContents(h, adopt.get(id)) : p;
    });
    localArray.splice(0, localArray.length, ...next);
  }

  return {
    state,
    /** The first read of the workspace: Node's readJson fallback, plus the base and stamp. */
    load() {
      const read = readProjectsFile(file);
      if (read.corrupt) warn(`[rust-projects] ${file} is not readable as { projects: [...] }; starting from an empty list`);
      const projects = read.projects || [];
      rebase(projects);
      state.stamp = read.stamp;
      return projects;
    },
    /** At each request start: takes in the other writer's changes (no lock: its writes are renames). */
    refresh(localArray) {
      // #1264: a store save in flight re-reads the file itself and leaves the stamp unset, so the
      // first request after it takes in the rest; refreshing now would move its base under it.
      if (remote && remote.queue.pending()) return false;
      if (stampOf(statOrNull(file)) === state.stamp) return false;
      const read = readProjectsFile(file);
      if (read.corrupt) return false; // keep this view; the next save replaces the file
      const { result, adopt } = merge(localArray, state.base, read.projects);
      const disk = byId(read.projects);
      // The base is now the disk; what this process changed and has not saved still differs from it.
      const nextBase = new Map();
      for (const [id, p] of disk) if (state.base.has(id) || result.some((q) => idOf(q) === id)) nextBase.set(id, JSON.stringify(p));
      apply(localArray, result, adopt);
      state.base = nextBase;
      state.stamp = read.stamp;
      return true;
    },
    /** saveProjects: the merge, written under the lock. `afterWrite(result)` runs still holding it
     *  (#1806: the source-text collection, so it sees exactly what was written). */
    save(localArray, afterWrite = null) {
      if (remote) return remote.queue.run('projects.json', () => saveRemote(localArray, afterWrite));
      lock(file, () => {
        const read = readProjectsFile(file);
        if (read.corrupt) {
          warn(`[rust-projects] ${file} is not readable as { projects: [...] }; replacing it with this process's view`);
          atomicJson(file, { projects: localArray });
        } else {
          const { result, adopt } = merge(localArray, state.base, read.projects);
          atomicJson(file, { projects: result });
          apply(localArray, result, adopt);
        }
        rebase(localArray);
        state.stamp = stampOf(statOrNull(file));
        if (afterWrite) afterWrite(localArray);
      });
    },
  };

  /** The same merge as save(), against the store's copy, written only if it is still that copy.
   *  Nothing awaits between a merge and its text, so the text is one consistent view; what this
   *  process changes while the write is in flight is merged in after it (and saved by the save
   *  that change asked for, queued behind this one). */
  async function saveRemote(localArray, afterWrite) {
    const { MAX_ATTEMPTS, busy } = require('./project-store-client.cjs');
    // A save before this one failed: this view holds a change the disk does not, so it never writes.
    if (remote.failed) throw remote.failed;
    try { return await attempts(); }
    // #1915: marked here, synchronously, before any other queued save of this view can start.
    catch (e) { remote.failed = remote.failed || e; throw e; }
    async function attempts() {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const snap = await remote.client.read(remote.user, 'projects.json');
      const disk = parseProjectsText(snap.text);
      let written;
      if (disk.corrupt) {
        warn(`[rust-projects] ${file} is not readable as { projects: [...] }; replacing it with this process's view`);
        written = Array.from(localArray);
      } else written = merge(localArray, state.base, disk.projects).result;
      const text = projectsText(written);
      const done = await remote.client.write(remote.user, 'projects.json', snap.version, text);
      if (done.conflict) continue;
      // `written` is on disk now: take it in as a refresh would, keeping what changed here since.
      const writtenCopy = JSON.parse(projectsText(written)).projects;
      const { result, adopt } = merge(localArray, state.base, writtenCopy);
      apply(localArray, result, adopt);
      rebase(writtenCopy);
      state.stamp = stampIfStill(file, text);
      // The source-text collection keeps what either list points at: this view now, and anything
      // written that it no longer holds (each project once).
      if (afterWrite) { const here = new Set(localArray.map(idOf)); afterWrite([...localArray, ...writtenCopy.filter((p) => !here.has(idOf(p)))]); }
      return;
    }
    throw busy();
    }
  }
}

/** Whether the chat-list slice is on (see the header): the switch, and the supervisor's
 *  NOEVIA_RUST_PROJECT_CHATS_CONFIRMED=1. Silent when only that is missing: a front that answers
 *  the images alone is a supported pairing, not a misconfiguration. */
function chatsEnabledFrom(env = process.env, warn = console.warn) {
  return enabledFrom(env, warn) && env.NOEVIA_RUST_PROJECT_CHATS_CONFIRMED === '1';
}

/** Whether the free-chat slice is on (see the header): the switch, and the supervisor's
 *  NOEVIA_RUST_FREE_CHATS_CONFIRMED=1. Silent when only that is missing (a front without the
 *  slice is a supported pairing). */
function freeChatsEnabledFrom(env = process.env, warn = console.warn) {
  return enabledFrom(env, warn) && env.NOEVIA_RUST_FREE_CHATS_CONFIRMED === '1';
}

/** Whether the project-writes slices are the front's (see the header): the projects switch,
 *  NOEVIA_RUST_PROJECT_WRITES=1 and the supervisor's NOEVIA_RUST_PROJECT_WRITES_CONFIRMED=1. Warns
 *  when the switch is set without the confirmation (the front then refuses to start, or lacks the
 *  slice): Node keeps answering, as before. */
function projectWritesEnabledFrom(env = process.env, warn = console.warn) {
  if (env.NOEVIA_RUST_PROJECT_WRITES !== '1') return false;
  if (!enabledFrom(env, warn)) return false;
  if (env.NOEVIA_RUST_PROJECT_WRITES_CONFIRMED !== '1') {
    warn('NOEVIA_RUST_PROJECT_WRITES=1 is ignored: the supervisor has not confirmed that the Rust front supports rust-project-writes (NOEVIA_RUST_PROJECT_WRITES_CONFIRMED).');
    return false;
  }
  return true;
}

// chat-lists.cjs LIST_CAP (required lazily there; equal by test).
const FREE_LIST_CAP = 1000;

/** free-chats.json as workspace.cjs readJson(file, []) reads it, through one descriptor, with its
 *  stamp: `value` is the parsed JSON, [] when the file is missing or not JSON (`invalid` set for
 *  the latter). An I/O error other than a missing file is thrown. */
function readFreeChatsFile(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch (e) { if (e.code === 'ENOENT') return { value: [], stamp: null, invalid: false }; throw e; }
  try {
    const stamp = stampOf(fs.fstatSync(fd));
    try { return { value: JSON.parse(fs.readFileSync(fd, 'utf8')), stamp, invalid: false }; }
    catch { return { value: [], stamp, invalid: true }; }
  } finally { fs.closeSync(fd); }
}

/** The free list merged with the other writer's (see the header): mergeIdList, then newest first
 *  as mergeChats orders (a stable sort on `updatedAt || 0`, a non-number counting as 0), capped. */
function mergeFreeChats(ours, base, theirs) {
  const key = (c) => (c && typeof c === 'object' && typeof c.updatedAt === 'number' && !Number.isNaN(c.updatedAt) ? c.updatedAt : 0);
  return mergeIdList(ours, base, theirs).sort((a, b) => (key(b) > key(a) ? 1 : key(b) < key(a) ? -1 : 0)).slice(0, FREE_LIST_CAP);
}

/**
 * The coordinated free-chats.json of one workspace while the free-chat slice is on (see the
 * header). The workspace calls load() once for its `freeChats`, refresh(workspace) at each request
 * start and save(workspace) for saveFreeChats; an array is updated in place.
 */
/** `remote`: as createProjectsFile's. */
function createFreeChatsFile(file, { atomicJson, warn = console.warn, lock = withFileLock, remote = null } = {}) {
  // base: JSON.stringify of the value as last read from (or written to) disk.
  const state = { base: JSON.stringify([]), stamp: null };
  const baseList = () => { try { const v = JSON.parse(state.base); return Array.isArray(v) ? v : null; } catch { return null; } };
  const put = (workspace, value) => {
    if (Array.isArray(workspace.freeChats) && Array.isArray(value)) { if (workspace.freeChats !== value) workspace.freeChats.splice(0, workspace.freeChats.length, ...value); }
    else workspace.freeChats = value;
  };
  return {
    state,
    /** The first read: workspace.cjs readJson(file, []), plus the base and stamp. */
    load() {
      let read;
      try { read = readFreeChatsFile(file); } catch { read = { value: [], stamp: null, invalid: true }; }
      state.base = JSON.stringify(read.value);
      state.stamp = read.stamp;
      return read.value;
    },
    /** At each request start: takes in the other writer's change (no lock: its writes are renames). */
    refresh(workspace) {
      if (remote && remote.queue.pending()) return false; // #1264: as createProjectsFile's
      if (stampOf(statOrNull(file)) === state.stamp) return false;
      const read = readFreeChatsFile(file);
      if (read.invalid) return false; // keep this view; the next save replaces the file
      const local = workspace.freeChats, base = baseList();
      const unchanged = JSON.stringify(local) === state.base;
      put(workspace, !unchanged && Array.isArray(local) && Array.isArray(read.value) && base ? mergeFreeChats(local, base, read.value) : read.value);
      state.base = JSON.stringify(read.value);
      state.stamp = read.stamp;
      return true;
    },
    /** saveFreeChats: this process's list, merged with the other writer's when it wrote since. */
    save(workspace) {
      if (remote) return remote.queue.run('free-chats.json', () => saveRemote(workspace));
      lock(file, () => {
        const read = readFreeChatsFile(file);
        const local = workspace.freeChats, base = baseList();
        let out = local;
        if (read.invalid) warn(`[rust-projects] ${file} is not JSON; replacing it with this process's list`);
        else if (JSON.stringify(read.value) !== state.base && Array.isArray(local) && Array.isArray(read.value) && base) out = mergeFreeChats(local, base, read.value);
        atomicJson(file, out);
        put(workspace, out);
        state.base = JSON.stringify(out);
        state.stamp = stampOf(statOrNull(file));
      });
    },
  };

  /** save()'s merge against the store's copy, compare-and-swapped (see createProjectsFile). */
  async function saveRemote(workspace) {
    const { MAX_ATTEMPTS, busy } = require('./project-store-client.cjs');
    // A save before this one failed: this view holds a change the disk does not, so it never writes.
    if (remote.failed) throw remote.failed;
    try { return await attempts(); }
    // #1915: marked here, synchronously, before any other queued save of this view can start.
    catch (e) { remote.failed = remote.failed || e; throw e; }
    async function attempts() {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const snap = await remote.client.read(remote.user, 'free-chats.json');
      let disk; let invalid = false;
      if (snap.text === null) disk = [];
      else { try { disk = JSON.parse(snap.text); } catch { invalid = true; } }
      const local = workspace.freeChats, base = baseList();
      const localJson = JSON.stringify(local);
      let out = local;
      if (invalid) warn(`[rust-projects] ${file} is not JSON; replacing it with this process's list`);
      else if (JSON.stringify(disk) !== state.base && Array.isArray(local) && Array.isArray(disk) && base) out = mergeFreeChats(local, base, disk);
      const text = JSON.stringify(out, null, 2);
      const done = await remote.client.write(remote.user, 'free-chats.json', snap.version, text);
      if (done.conflict) continue;
      const written = JSON.parse(text);
      const now = workspace.freeChats;
      // Changed here while the write was in flight: those changes over what was written.
      put(workspace, JSON.stringify(now) === localJson || !Array.isArray(now) || !Array.isArray(written) ? written : mergeFreeChats(now, JSON.parse(localJson), written));
      state.base = JSON.stringify(written);
      state.stamp = stampIfStill(file, text);
      return;
    }
    throw busy();
    }
  }
}

/** For Node's copies of the Rust-owned write routes: true when it answered 503. */
function refuseOwned(enabled, json, res) {
  if (!enabled) return false;
  json(res, 503, { error: 'This route is served by the Rust front while NOEVIA_RUST_PROJECTS is on.', code: 'RUST_PROJECTS_OWNED' });
  return true;
}

module.exports = {
  enabledFrom, chatsEnabledFrom, freeChatsEnabledFrom, projectWritesEnabledFrom, withFileLock, merge, mergeFields, mergeIdList, createProjectsFile, readProjectsFile, refuseOwned, replaceContents,
  createFreeChatsFile, readFreeChatsFile, mergeFreeChats,
  OWNED_ROUTES, PROJECT_WRITE_ROUTES, LOCK_SUFFIX, LOCK_WAIT_MS, FLOCK_BUSY_STATUS, FREE_LIST_CAP,
};
