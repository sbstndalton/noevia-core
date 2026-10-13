'use strict';
// #1461 / #1508: a read that many callers ask for at once (every open tab polls /api/stats; each Models
// tab, the chat header and the auto-router ask for the installed list) is computed once. Callers that
// arrive while the call is in flight share it, and its answer is kept for `ttlMs` after it lands. A
// failed call is not kept, so the next caller tries again. `clear()` drops the answer at once; any write
// that changes what the read reports must call it (a load, an unload, a delete, a role or preset save).
//
// A read that a decision depends on (a load that has just finished, a delete that must confirm the model
// is gone) must not use this: it asks the source directly.
// `keep(value)` (optional) says whether an answer may be kept: a degraded answer is handed to the callers
// that were waiting, but the next caller asks again.
function createSharedRead(load, ttlMs, keep = () => true) {
  let entry = null;
  return {
    get() {
      const now = Date.now();
      if (entry && (entry.pending || entry.expiresAt > now)) return entry.promise;
      const current = { pending: true, expiresAt: Infinity, promise: null };
      // The source is asked now, not on a later tick: a caller that asks again straight after must share this call.
      try { current.promise = Promise.resolve(load()); } catch (err) { current.promise = Promise.reject(err); }
      entry = current;
      current.promise.then(
        (value) => {
          current.pending = false;
          if (keep(value)) current.expiresAt = Date.now() + ttlMs;
          else if (entry === current) entry = null;
        },
        () => { if (entry === current) entry = null; },
      );
      return current.promise;
    },
    clear() { entry = null; },
  };
}

module.exports = { createSharedRead };
