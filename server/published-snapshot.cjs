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
// A publisher whose build throws writes nothing: the file ages out and the front reports "unavailable"
// rather than the last thing it was told.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const VERSION = 1;

function fsyncDir(dir) {
  let fd;
  try { fd = fs.openSync(dir, 'r'); fs.fsyncSync(fd); } catch { /* best effort: the rename is already done */ } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* nothing */ } }
}

/** Writes one snapshot atomically. Throws when it cannot (the caller keeps the old file). */
function writeSnapshot(file, kind, everyMs, state, now = Date.now()) {
  const dir = path.dirname(file);
  const body = JSON.stringify({ version: VERSION, kind, writtenAt: now, everyMs, ...state });
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
 * A publisher of one snapshot file. `build()` returns the state (or throws); it never runs twice at
 * once, and a `changed()` that arrives while it runs is served by one more run right after.
 * @param {object} o
 * @param {string} o.file
 * @param {string} o.kind
 * @param {number} o.everyMs     the timer, and what the front is told to expect
 * @param {() => object|Promise<object>} o.build
 * @param {(err: Error) => void} [o.onError]
 * @param {() => number} [o.now]
 */
function createPublisher({ file, kind, everyMs, build, onError = () => {}, now = Date.now }) {
  let timer = null;
  let running = null;
  let again = false;
  let soon = null;

  async function run() {
    do {
      again = false;
      try { writeSnapshot(file, kind, everyMs, await build(), now()); } catch (err) { onError(err); }
    } while (again);
  }

  /** Publishes now (or right after the run in progress). Resolves when this state is on disk. */
  function publish() {
    if (running) { again = true; return running; }
    running = run().finally(() => { running = null; });
    return running;
  }

  return {
    publish,
    /** The state changed: publish soon (a burst of changes is one write). */
    changed() {
      if (soon) return;
      soon = setTimeout(() => { soon = null; publish(); }, 50);
      soon.unref();
    },
    start() {
      if (timer) return;
      publish();
      timer = setInterval(publish, everyMs);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      if (soon) clearTimeout(soon);
      timer = null; soon = null;
    },
  };
}

/** `RAG_STATUS_PUBLISH_MS`-style setting: an integer number of ms in [lo, hi], else `fallback`. */
function intervalFrom(value, fallback, lo = 1000, hi = 300000) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n >= lo && n <= hi ? n : fallback;
}

module.exports = { VERSION, writeSnapshot, createPublisher, intervalFrom };
