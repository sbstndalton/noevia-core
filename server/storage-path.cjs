'use strict';

// Storage path rules (#978): the guards every request-supplied storage path and upload filename
// passes through. Moved here unchanged from storage-client.cjs (safeRelativePath, cleanRoot,
// joinRoot) and uploads.cjs validate (the plain-filename rule). One deliberate tightening since the
// move: safeRelativePath refuses a path containing NUL.
//
// `storage-path` (sbstndalton/noevia-rs, in the dav-parse.wasm module pinned by
// server/dav-parse.lock) is the Rust port. STORAGE_PATH_IMPL=js|wasm picks one (default js; any
// other value means js, with one warning). `wasm` FAILS CLOSED: a missing or tampered module, a
// refusal, a trap, an unexpected reply or input that cannot cross unchanged throws (500, or 400 for
// an oversized input or one that cannot cross unchanged, e.g. a lone surrogate) instead of falling back to the JS rules. The thrown message is fixed; the
// details are logged.

const davParseWasm = require('./dav-parse-wasm.cjs');

function safeRelativePathJs(raw) {
  const value = String(raw || '').trim().replace(/\\/g, '/');
  if (!value || value.length > 500) return '';
  if (value.startsWith('/')) return '';
  // #978: no filesystem or object store names a file with NUL; refuse it rather than pass it on.
  if (value.includes('\0')) return '';
  const segments = value.split('/').filter(Boolean);
  if (!segments.length) return '';
  if (segments.some((s) => s === '.' || s === '..')) return '';
  return segments.join('/');
}

function cleanRootJs(corpusRoot) {
  return String(corpusRoot || '').replace(/^\/+|\/+$/g, '');
}

function joinRootJs(corpusRoot, relative) {
  const root = cleanRootJs(corpusRoot);
  return [root, relative].filter(Boolean).join('/');
}

/** uploads.cjs validate's filename rule: a plain name of at most 200 characters. */
function isPlainFilenameJs(name) {
  return !(!name || name.length > 200 || /[\/\\\x00-\x1f]/.test(name) || name === '.' || name === '..');
}

const PUBLIC_FAILURE = 'storage path could not be checked';
const IMPLS = new Set(['js', 'wasm']);
let warnedImpl = '';

/** STORAGE_PATH_IMPL, read per call so a test (or an owner flip plus restart) takes effect. */
function storagePathImpl(env = process.env) {
  const raw = env.STORAGE_PATH_IMPL;
  if (raw === undefined || raw === '') return 'js';
  const value = String(raw).trim().toLowerCase();
  if (IMPLS.has(value)) return value;
  if (warnedImpl !== value) {
    warnedImpl = value;
    console.warn(`[storage] STORAGE_PATH_IMPL=${JSON.stringify(String(raw))} is not js or wasm; using js`);
  }
  return 'js';
}

function viaWasm(op, a, b) {
  try { return davParseWasm.storagePath(op, a, b); } catch (err) {
    const reason = err instanceof davParseWasm.DavParseError ? err.reason : 'unexpected';
    console.warn(`[storage] storage-path ${op} failed (${reason}): ${err?.message || err}`);
    throw Object.assign(new Error(PUBLIC_FAILURE), { status: reason === 'too_large' || reason === 'input' ? 400 : 500, code: 'storage_path_failed', reason });
  }
}

// The JS coercions (String(raw || ''), filter(Boolean)) stay on this side: only strings cross.
function safeRelativePath(raw, { impl = storagePathImpl() } = {}) {
  return impl === 'wasm' ? viaWasm('safeRelativePath', String(raw || '')) : safeRelativePathJs(raw);
}

function cleanRoot(corpusRoot, { impl = storagePathImpl() } = {}) {
  return impl === 'wasm' ? viaWasm('cleanRoot', String(corpusRoot || '')) : cleanRootJs(corpusRoot);
}

function joinRoot(corpusRoot, relative, { impl = storagePathImpl() } = {}) {
  if (impl !== 'wasm') return joinRootJs(corpusRoot, relative);
  // Every caller passes a string (or nothing); anything else is refused, not coerced.
  if (relative !== undefined && relative !== null && typeof relative !== 'string') return viaWasm('joinRoot', String(corpusRoot || ''), null);
  return viaWasm('joinRoot', String(corpusRoot || ''), relative || '');
}

function isPlainFilename(name, { impl = storagePathImpl() } = {}) {
  if (impl !== 'wasm') return isPlainFilenameJs(name);
  if (!name) return false;
  // A non-string name (a number from JSON) is refused rather than coerced.
  return typeof name === 'string' && viaWasm('isPlainFilename', name);
}

module.exports = {
  safeRelativePath, cleanRoot, joinRoot, isPlainFilename, storagePathImpl, PUBLIC_FAILURE,
  safeRelativePathJs, cleanRootJs, joinRootJs, isPlainFilenameJs,
};
