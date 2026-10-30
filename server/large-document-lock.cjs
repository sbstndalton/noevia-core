'use strict';
// #1871: one large document at a time, process-wide. A PDF over 25 MiB is held whole while it is read
// (its cross-reference table is at the end), so two at once would double the peak on a host with no swap
// whose GPU takes its memory from system RAM (#697). The lock is held from the storage read to the end of
// extraction, by the synchronous source sync and by background work alike. Re-entrant within one async
// call chain: a caller already holding it (the sync route around read + ingest) passes straight through
// the inner take in documents.cjs.
//
// RE-ENTRANCY RULE (#1872): the re-entrancy is an AsyncLocalStorage store, and a store is inherited by
// everything started inside the holder, including timers, promises and fire-and-forget work. Any such
// detached work that outlives or runs apart from the holder would silently skip the lock. Work that must
// not count as the holder's (a background job, a sweep, a timer-driven pass) is started through
// `detached(fn)`, which runs it outside the holder's context. At the time of writing nothing inside a
// holder starts detached work (the figure sweep, embedding migration and source jobs are all started by
// timers or requests outside it); this is the rule for whoever adds some.
//
// BOUNDS (#1872): a waiter gives up after ACQUIRE_WAIT_MS and fails as "busy" (status 503, the same shape
// the extraction workers use, so every caller already treats it as a passing failure and tries again on
// the next sync). A holder is never force-released (that would let two large documents overlap), but a
// hold longer than HOLD_WARN_MS logs one line, without any document content.
const { AsyncLocalStorage } = require('node:async_hooks');
const crypto = require('node:crypto');
// #2191 round 7: the host-wide half, shared with the Rust front (large-document-file-lock.cjs).
const fileLock = require('./large-document-file-lock.cjs');

const LARGE_BYTES = 25 * 1024 * 1024;
const ACQUIRE_WAIT_MS = 2 * 60 * 1000;
const HOLD_WARN_MS = 30 * 60 * 1000;
const holder = new AsyncLocalStorage();
let tail = Promise.resolve();
let outstanding = 0; // acquires queued or holding, so a new one knows whether it will have to wait
// #1878: cumulative counts since start, for tests and a release watch. Counts only, no content.
const counters = { acquires: 0, waited: 0, waitMsTotal: 0, busy: 0 };

/** #1878: a short, one-way tag of a document reference (its id), so a log line can be matched across
 *  lines without carrying the id or the file name. */
const refHash = (ref) => {
  let value = ref;
  try { if (typeof value === 'function') value = value(); } catch { value = null; }
  return value == null || value === '' ? 'none' : crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 8);
};

const positive = (value, fallback) => { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : fallback; };
const acquireWaitMs = () => positive(process.env.LARGE_DOCUMENT_ACQUIRE_WAIT_MS, ACQUIRE_WAIT_MS);
const holdWarnMs = () => positive(process.env.LARGE_DOCUMENT_HOLD_WARN_MS, HOLD_WARN_MS);

const busy = () => Object.assign(new Error('Large-document processing is busy; refresh to retry.'), { status: 503, code: 'large-document-busy' });

/** Wait for the lock (queued behind any holder, first come first served) and return its `release`.
 *  Rejects with a busy error after the acquire wait, leaving the queue intact for those behind. */
async function acquire(ref) {
  const mustWait = outstanding > 0;
  const waitStart = Date.now();
  outstanding += 1;
  counters.acquires += 1;
  let release;
  const previous = tail;
  const mine = new Promise((resolve) => { release = resolve; });
  tail = mine;
  let timer;
  const timedOut = new Promise((resolve) => { timer = setTimeout(() => resolve(false), acquireWaitMs()); });
  const got = await Promise.race([previous.then(() => true), timedOut]);
  clearTimeout(timer);
  let releaseFile = null;
  if (got) {
    // This process's turn: now the host's, within what is left of the same wait.
    try { releaseFile = await fileLock.take(waitStart + acquireWaitMs()); } catch (err) { outstanding -= 1; release(); throw err; }
    if (!releaseFile) {
      outstanding -= 1; release();
      counters.busy += 1; counters.waited += 1; counters.waitMsTotal += Date.now() - waitStart;
      console.warn(`[large-document-lock] gave up waiting for another process: doc=${refHash(ref)} waitedMs=${Date.now() - waitStart} outcome=busy`);
      throw busy();
    }
  }
  if (!got) {
    // Not taking it: pass the turn on as soon as the holder ahead lets go, so the queue behind still moves.
    previous.then(() => { outstanding -= 1; release(); });
    counters.busy += 1; counters.waited += 1; counters.waitMsTotal += Date.now() - waitStart;
    console.warn(`[large-document-lock] gave up waiting: doc=${refHash(ref)} waitedMs=${Date.now() - waitStart} outcome=busy`);
    throw busy();
  }
  if (mustWait) {
    const waitedMs = Date.now() - waitStart;
    counters.waited += 1; counters.waitMsTotal += waitedMs;
    console.log(`[large-document-lock] acquired after waiting: doc=${refHash(ref)} waitedMs=${waitedMs}`);
  }
  const startedAt = Date.now();
  const warn = setTimeout(() => {
    console.warn(`[large-document-lock] held for over ${Math.round((Date.now() - startedAt) / 60000)} minutes; still running: doc=${refHash(ref)}`);
  }, holdWarnMs());
  warn.unref?.();
  let released = false;
  return () => { if (released) return; released = true; outstanding -= 1; clearTimeout(warn); releaseFile(); release(); };
}

/** Run `fn` holding the lock. */
async function withLargeDocument(fn, ref) {
  if (holder.getStore()) return fn();
  const release = await acquire(ref);
  try { return await holder.run(true, fn); } finally { release(); }
}

/** Run `fn` in the context of a caller that already took the lock with `acquire()`. */
const holding = (fn) => holder.run(true, fn);

/** Run `fn` outside any holder's context, so work it starts is not mistaken for the holder's. */
const detached = (fn) => holder.exit(fn);

/** Whether a document of `size` bytes (null or undefined: not known yet) must take the lock. */
const isLarge = (size) => !(Number.isFinite(size) && size >= 0 && size <= LARGE_BYTES);

/** `fn` under the lock when `size` says the document is large or does not say; else as it is. */
const ifLarge = (size, fn, ref) => (isLarge(size) ? withLargeDocument(fn, ref) : fn());

const held = () => !!holder.getStore();

module.exports = { counters, refHash, withLargeDocument, ifLarge, isLarge, held, acquire, holding, detached, LARGE_BYTES, ACQUIRE_WAIT_MS, HOLD_WARN_MS };
