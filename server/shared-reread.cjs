'use strict';
// sbstndalton/noevia#2190: Node as a re-reader of a store the Rust front writes.
//
// When Rust becomes the single writer of data that Node's chat path still needs in process (the
// decision configuration per decision, and the same shape for provider rows and connector
// policies), Node must not keep a boot-time copy: it would act on a stale value until a restart.
// A re-reader instead asks a cheap change signal on every use and reloads only when the signal
// differs from the one its value was loaded under:
//
//   - a settings row: its content fingerprint (feature-setting-source.cjs readFact().source),
//     which changes in the same statement as the write;
//   - a file: fileSignal(path), its inode, size and mtime (an atomic rename changes the inode).
//
// `signal()` may throw (store unavailable): the re-reader then answers `fallback(error)` and forgets
// its token, so the next use reads again; it never serves the last good value past a failed read.
// A signal read and its load are two steps; a write landing between them is caught by the next use
// (the token recorded is the earlier one, so the next signal differs and reloads). Callers that
// can read value and signal in one step pass both through `signal` (see decision-settings.cjs).
const fs = require('node:fs');

const UNSET = Symbol('unset');

/**
 * @template T
 * @param {object} o
 * @param {() => unknown} o.signal     the change signal; compared with Object.is
 * @param {(token: unknown) => T} o.load  the value for this signal; may throw (then fallback)
 * @param {(error: unknown) => T} o.fallback  the value while the store cannot be read
 */
function createReread({ signal, load, fallback }) {
  if (typeof signal !== 'function' || typeof load !== 'function' || typeof fallback !== 'function') throw new TypeError('signal, load and fallback are required');
  let token = UNSET, value, loads = 0;
  return Object.freeze({
    /** The value as of now: reloaded when the signal changed since the last load. */
    current() {
      let next;
      try { next = signal(); } catch (error) { token = UNSET; return fallback(error); }
      if (token !== UNSET && Object.is(next, token)) return value;
      try { value = load(next); } catch (error) { token = UNSET; return fallback(error); }
      token = next; loads++;
      return value;
    },
    /** Forget the loaded value: the next use reads the store again. */
    invalidate() { token = UNSET; },
    /** How many times the value was (re)loaded, for tests and diagnostics. */
    get loads() { return loads; },
  });
}

/** A file's change signal: '' when missing, else inode:size:mtimeNs. Other stat errors throw. */
function fileSignal(file, fsImpl = fs) {
  let st;
  try { st = fsImpl.statSync(file, { bigint: true }); } catch (error) { if (error && error.code === 'ENOENT') return ''; throw error; }
  return `${st.ino}:${st.size}:${st.mtimeNs}`;
}

module.exports = Object.freeze({ createReread, fileSignal });
