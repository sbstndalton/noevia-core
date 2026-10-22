'use strict';

// Storage path rules (#978): the guards every request-supplied storage path passes through
// (safeRelativePath, cleanRoot, joinRoot). The plain upload filename rule is the same crate's, run
// by upload-sniff.cjs's validate inside the module (its JS wrapper here had no caller and is gone).
//
// `storage-path` (sbstndalton/noevia-rs, in the dav-parse.wasm module pinned by
// server/dav-parse.lock) decides, always (since #1071; it was STORAGE_PATH_IMPL=wasm, default js).
// The Rust front's native storage reads run the same crate, so both fronts share one policy. A
// leftover STORAGE_PATH_IMPL only warns at startup (dav-parse-wasm.cjs RETIRED_FLAGS). The JS rules
// are a test oracle: tests/server/oracle/storage-path.cjs.
//
// It FAILS CLOSED: a missing or tampered module, a refusal, a trap or an unexpected reply throws
// 500, and input that cannot cross unchanged (a lone surrogate, an argument over 64 KiB, a
// non-string joinRoot part) throws 400, instead of answering. The thrown message is fixed; the
// details are logged.

const davParseWasm = require('./dav-parse-wasm.cjs');

const PUBLIC_FAILURE = 'storage path could not be checked';

function viaWasm(op, a, b) {
  try { return davParseWasm.storagePath(op, a, b); } catch (err) {
    const reason = err instanceof davParseWasm.DavParseError ? err.reason : 'unexpected';
    console.warn(`[storage] storage-path ${op} failed (${reason}): ${err?.message || err}`);
    throw Object.assign(new Error(PUBLIC_FAILURE), { status: reason === 'too_large' || reason === 'input' ? 400 : 500, code: 'storage_path_failed', reason });
  }
}

// The JS coercions (String(raw || '')) stay on this side: only strings cross.
function safeRelativePath(raw) {
  return viaWasm('safeRelativePath', String(raw || ''));
}

function cleanRoot(corpusRoot) {
  return viaWasm('cleanRoot', String(corpusRoot || ''));
}

function joinRoot(corpusRoot, relative) {
  // Every caller passes a string (or nothing); anything else is refused, not coerced.
  if (relative !== undefined && relative !== null && typeof relative !== 'string') return viaWasm('joinRoot', String(corpusRoot || ''), null);
  return viaWasm('joinRoot', String(corpusRoot || ''), relative || '');
}

module.exports = { safeRelativePath, cleanRoot, joinRoot, PUBLIC_FAILURE };
