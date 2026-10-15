'use strict';
// #1871: one large document at a time, process-wide. A PDF over 25 MiB is held whole while it is read
// (its cross-reference table is at the end), so two at once would double the peak on a host with no swap
// whose GPU takes its memory from system RAM (#697). The lock is held from the storage read to the end of
// extraction, by the synchronous source sync and by background work alike. Re-entrant within one async
// call chain: a caller already holding it (the sync route around read + ingest) passes straight through
// the inner take in documents.cjs.
const { AsyncLocalStorage } = require('node:async_hooks');

const LARGE_BYTES = 25 * 1024 * 1024;
const holder = new AsyncLocalStorage();
let tail = Promise.resolve();

/** Run `fn` holding the lock (queued behind any holder, first come first served). */
async function withLargeDocument(fn) {
  if (holder.getStore()) return fn();
  let release;
  const previous = tail;
  tail = new Promise((resolve) => { release = resolve; });
  await previous;
  try { return await holder.run(true, fn); } finally { release(); }
}

/** Whether a document of `size` bytes (null or undefined: not known yet) must take the lock. */
const isLarge = (size) => !(Number.isFinite(size) && size >= 0 && size <= LARGE_BYTES);

/** `fn` under the lock when `size` says the document is large or does not say; else as it is. */
const ifLarge = (size, fn) => (isLarge(size) ? withLargeDocument(fn) : fn());

const held = () => !!holder.getStore();

module.exports = { withLargeDocument, ifLarge, isLarge, held, LARGE_BYTES };
