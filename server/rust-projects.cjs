'use strict';
// M4 of the full-Rust migration (noevia docs/adr-0001-rust-and-repo-split.md, "Amendment
// 2026-10-10"): the Rust front (noevia-rs bins/noevia-server, crates/server-projects) takes over
// project routes slice by slice. The first slice is a project's image assets
// (POST /api/projects/{id}/assets, GET and DELETE /api/projects/{id}/assets/{assetId}).
//
// The switch is NOEVIA_RUST_PROJECTS=1 (exactly) together with NOEVIA_FRONT=rust, the M3 switch
// (NOEVIA_RUST_AUTH=1, confirmed: the front gates Rust-owned routes itself) and the supervisor's
// NOEVIA_RUST_PROJECTS_CONFIRMED=1 (set only once the front's --features lists rust-projects).
// Anything less and the switch is ignored here (a warning is printed) and Node keeps doing
// everything, as before.
//
// projects.json cannot have one writer yet: the chat routes, still Node's, keep each project's chat
// metas in it. So while the switch is on, both processes write it only under one shared lock and
// never from a stale copy:
//
//   - the lock is `projects.json.lock` beside the file, created with O_CREAT|O_EXCL (mode 0600,
//     content "<pid> <ms>\n") and unlinked on release. A writer waits up to LOCK_WAIT_MS, retrying
//     every LOCK_RETRY_MS; a lock older than LOCK_STALE_MS (a writer that died mid-write) is
//     removed. Holds are one read-modify-write, a few milliseconds. noevia-rs
//     crates/server-projects `lock` is the other half; keep the constants equal.
//   - Rust re-reads the file under the lock and changes only the project it serves.
//   - Node keeps its cached workspace, but a save is a three-way merge under the lock: the
//     projects this process changed, added or removed since it last read the file are applied to
//     what is on disk now; every other project is taken from disk. A project both sides changed
//     between two reads is merged per top-level field (this process's value where it changed the
//     field), so a chat save does not drop an image Rust added meanwhile; only the same field
//     changed on both sides is last-writer-wins. Every request start re-reads the file
//     when its (ino, size, mtime) changed, refreshing unchanged projects in place, so a handler
//     holding a project object still sees the current one.
//   - Node's copies of the Rust-owned write routes answer 503 RUST_PROJECTS_OWNED (refuseOwned),
//     so a request that reaches Node directly cannot write behind the front's back. The reads stay.
//
// Removed, with Node's copies of the routes, once Rust owns every projects.json writer.

const fs = require('fs');

const LOCK_SUFFIX = '.lock';
const LOCK_STALE_MS = 10000;
const LOCK_WAIT_MS = 3000;
const LOCK_RETRY_MS = 5;

/** The routes the Rust front answers under the switch: METHOD path-pattern. noevia-rs
 *  contracts/http/routes.toml (switch = "NOEVIA_RUST_PROJECTS") is the other half. */
const OWNED_ROUTES = Object.freeze(new Set([
  'POST /api/projects/{id}/assets',
  'GET /api/projects/{id}/assets/{assetId}',
  'DELETE /api/projects/{id}/assets/{assetId}',
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

const sleeper = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) { Atomics.wait(sleeper, 0, 0, ms); }

/** Runs `fn` (synchronously) holding `<file>.lock`. Throws 503 PROJECTS_BUSY after LOCK_WAIT_MS. */
function withFileLock(file, fn, { now = Date.now, sleep = sleepSync, pid = process.pid } = {}) {
  const lock = file + LOCK_SUFFIX;
  const deadline = now() + LOCK_WAIT_MS;
  for (;;) {
    let fd;
    try { fd = fs.openSync(lock, 'wx', 0o600); }
    catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let st = null;
      try { st = fs.statSync(lock); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (st && now() - st.mtimeMs > LOCK_STALE_MS) {
        try { fs.unlinkSync(lock); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        continue;
      }
      if (now() >= deadline) throw busy();
      if (st) sleep(LOCK_RETRY_MS);
      continue;
    }
    try {
      try { fs.writeSync(fd, `${pid} ${now()}\n`); } finally { fs.closeSync(fd); }
      return fn();
    } finally {
      try { fs.unlinkSync(lock); } catch { /* removed as stale by another writer: nothing to release */ }
    }
  }
}

const idOf = (p) => (p && typeof p === 'object' && typeof p.id === 'string' ? p.id : null);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** One project both sides changed since the last read: per top-level field, this process's value
 *  where it changed the field, the disk's otherwise (disk key order, new local fields appended). */
function mergeFields(ours, baseJson, theirs) {
  let base;
  try { base = JSON.parse(baseJson); } catch { base = {}; }
  const out = {};
  for (const k of Object.keys(theirs)) {
    if (same(ours[k], base[k])) out[k] = theirs[k];
    else if (own(ours, k) && ours[k] !== undefined) out[k] = ours[k];
    // removed here: left out
  }
  for (const k of Object.keys(ours)) if (!own(out, k) && !own(theirs, k) && !same(ours[k], base[k])) out[k] = ours[k];
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
function createProjectsFile(file, { atomicJson, warn = console.warn, lock = withFileLock } = {}) {
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
    /** saveProjects: the merge, written under the lock. */
    save(localArray) {
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
      });
    },
  };
}

/** For Node's copies of the Rust-owned write routes: true when it answered 503. */
function refuseOwned(enabled, json, res) {
  if (!enabled) return false;
  json(res, 503, { error: 'This route is served by the Rust front while NOEVIA_RUST_PROJECTS is on.', code: 'RUST_PROJECTS_OWNED' });
  return true;
}

module.exports = {
  enabledFrom, withFileLock, merge, mergeFields, createProjectsFile, readProjectsFile, refuseOwned, replaceContents,
  OWNED_ROUTES, LOCK_SUFFIX, LOCK_STALE_MS, LOCK_WAIT_MS, LOCK_RETRY_MS,
};
