'use strict';
// State only this process knows, published for the Rust front (sbstndalton/noevia#2190 close-out):
// the retrieval status behind GET /api/health (rust-health.cjs) and the served catalogue behind
// GET /api/auto-roles (rust-auto-roles.cjs).
//
// The file is the whole channel. It is written atomically (a temporary file in the same directory,
// fsynced, renamed over the old one, the directory fsynced; mode 0600) so a reader sees the old file
// or the new one, never half of one, and carries
//   { version: 1, kind, writtenAt: <ms since the epoch>, everyMs: <the publishing interval>, ...state }
// The front (noevia-rs bins/noevia-server snapshot.rs) trusts a file only when it is of this version
// and kind and `writtenAt` is within two `everyMs` of its own clock, so the publisher writes on every
// tick even when nothing changed (that is the heartbeat), and writes at once when the state changes.
// A publisher whose build throws, or does not finish within two intervals, writes nothing: the file ages
// out and the front reports "unavailable" rather than the last thing it was told.
//
// Publishing is demand-driven (the review of this round, M1): the builds probe the embedder and the model
// engines, which an idle installation must not have probed around the clock. The front touches a demand
// marker (DEMAND_FILE in the data directory) on every signed-in GET /api/health and GET /api/auto-roles;
// a publisher given a `demand` runs only while the marker's mtime is under DEMAND_WINDOW_MS old, starts
// at once when it appears (fs.watch, not keeping the process alive, with a stat poll behind it) and
// stops its timers when it ages out. The front waits up to 2 s for a fresh file after an idle spell.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const VERSION = 1;
/** The demand marker's name in the data directory (noevia-rs bins/noevia-server snapshot.rs `DEMAND_FILE`). */
const DEMAND_FILE = 'snapshot-demand';
/** Publishers run while the marker is younger than this (snapshot.rs `DEMAND_WINDOW_MS`). */
const DEMAND_WINDOW_MS = 60000;
/** How often the marker is looked at when no event told us (a stat). */
const DEMAND_POLL_MS = 1000;
/** A marker dated this far ahead of the clock is not demand (the same skew the front allows a snapshot). */
const DEMAND_SKEW_MS = 5000;

function fsyncDir(dir) {
  let fd;
  try { fd = fs.openSync(dir, 'r'); fs.fsyncSync(fd); } catch { /* best effort: the rename is already done */ } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* nothing */ } }
}

/** Writes one snapshot atomically. Throws when it cannot (the caller keeps the old file). */
function writeSnapshot(file, kind, everyMs, state, now = Date.now()) {
  const dir = path.dirname(file);
  // The header comes first in the file and wins over a state that names the same keys.
  const header = { version: VERSION, kind, writtenAt: now, everyMs };
  const body = JSON.stringify({ ...header, ...state, ...header });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeSync(fd, body);
    fs.fsyncSync(fd);
  } catch (err) {
    try { fs.closeSync(fd); } catch { /* nothing */ }
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  fs.closeSync(fd);
  try { fs.renameSync(tmp, file); } catch (err) { fs.rmSync(tmp, { force: true }); throw err; }
  fsyncDir(dir);
}

/**
 * Whether someone has asked for the snapshots lately: the demand marker's mtime is under `windowMs` old
 * (and not further ahead of the clock than the skew). A marker that is missing, is not a plain file or
 * cannot be read is no demand.
 * @param {string} dir
 * @param {object} [o]
 */
function createDemand({ dir, windowMs = DEMAND_WINDOW_MS, pollMs = DEMAND_POLL_MS, now = Date.now }) {
  const file = path.join(dir, DEMAND_FILE);
  const listeners = new Set();
  let live = false;
  let timer = null;
  let watcher = null;

  /** Reads the marker now. */
  function active() {
    try {
      const st = fs.lstatSync(file);
      if (!st.isFile()) return false;
      const age = now() - st.mtimeMs;
      return age >= -DEMAND_SKEW_MS && age < windowMs;
    } catch { return false; }
  }

  /** Looks at the marker and tells the listeners when the answer changed. */
  function check() {
    const next = active();
    if (next === live) return;
    live = next;
    for (const fn of [...listeners]) { try { fn(live); } catch { /* a listener never breaks the others */ } }
  }

  return {
    file, windowMs, pollMs,
    active,
    check,
    /** `fn(live)` on every change; returns the way to stop listening. */
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    start() {
      if (timer) return;
      check();
      timer = setInterval(check, pollMs);
      timer.unref();
      try {
        watcher = fs.watch(dir, { persistent: false }, (_event, name) => { if (!name || String(name) === DEMAND_FILE) check(); });
        watcher.on('error', () => { try { watcher.close(); } catch { /* nothing */ } watcher = null; });
      } catch { watcher = null; /* the poll is the fallback */ }
    },
    stop() {
      if (timer) clearInterval(timer);
      if (watcher) { try { watcher.close(); } catch { /* nothing */ } }
      timer = null; watcher = null; live = false;
    },
  };
}

/**
 * A publisher of one snapshot file. `build()` returns the state (or throws); it never runs twice at
 * once, a `changed()` that arrives while it runs is served by one more run right after, and a build that
 * has not finished within `buildDeadlineMs` (two intervals) is abandoned: it writes nothing, and its
 * late result is dropped, so one stuck probe cannot stop the file from being renewed.
 * @param {object} o
 * @param {string} o.file
 * @param {string} o.kind
 * @param {number} o.everyMs     the timer, and what the front is told to expect
 * @param {() => object|Promise<object>} o.build
 * @param {(err: Error) => void} [o.onError]
 * @param {() => number} [o.now]
 * @param {number} [o.buildDeadlineMs]
 * @param {ReturnType<typeof createDemand>} [o.demand]  publish only while it says someone asks
 */
function createPublisher({ file, kind, everyMs, build, onError = () => {}, now = Date.now, buildDeadlineMs = everyMs * 2, demand = null }) {
  let timer = null;
  let running = null;
  let again = false;
  let soon = null;
  let started = false;
  let unsubscribe = null;

  /** `build()` raced against the deadline. */
  async function built() {
    let deadline;
    const late = new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error(`the build did not finish within ${buildDeadlineMs} ms`)), buildDeadlineMs);
      deadline.unref();
    });
    try { return await Promise.race([Promise.resolve().then(build), late]); } finally { clearTimeout(deadline); }
  }

  async function run() {
    do {
      again = false;
      try { writeSnapshot(file, kind, everyMs, await built(), now()); } catch (err) { onError(err); }
    } while (again);
  }

  /** Publishes now (or right after the run in progress). Resolves when this state is on disk. */
  function publish() {
    if (running) { again = true; return running; }
    running = run().finally(() => { running = null; });
    return running;
  }

  function tick() {
    if (demand && !demand.active()) { end(); return; }
    publish();
  }

  function begin() {
    if (timer) return;
    publish();
    timer = setInterval(tick, everyMs);
    timer.unref();
  }

  function end() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    publish,
    buildDeadlineMs,
    /** The state changed: publish soon (a burst of changes is one write), if anyone is asking. */
    changed() {
      if (soon || (demand && !demand.active())) return;
      soon = setTimeout(() => { soon = null; publish(); }, 50);
      soon.unref();
    },
    /** Without a demand source: publish at once and on the timer. With one: do that while it is live. */
    start() {
      if (started) return;
      started = true;
      if (!demand) { begin(); return; }
      unsubscribe = demand.subscribe((live) => { if (live) begin(); else end(); });
      if (demand.active()) begin();
    },
    stop() {
      end();
      if (soon) clearTimeout(soon);
      if (unsubscribe) unsubscribe();
      soon = null; unsubscribe = null; started = false;
    },
  };
}

/** `RAG_STATUS_PUBLISH_MS`-style setting: an integer number of ms in [lo, hi], else `fallback`. */
function intervalFrom(value, fallback, lo = 1000, hi = 300000) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n >= lo && n <= hi ? n : fallback;
}

module.exports = { VERSION, DEMAND_FILE, DEMAND_WINDOW_MS, DEMAND_POLL_MS, writeSnapshot, createDemand, createPublisher, intervalFrom };
