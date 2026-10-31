'use strict';

// TEST ORACLE (#1071): never required by production code (server/oracle-isolation.test.cjs
// enforces that). The JS reference for the storage path rules (#978), kept only so
// tools/gen-storage-fixtures.cjs can regenerate tests/fixtures/storage-path.v1.json and the
// differential tests can compare it with dav-parse.wasm (sbstndalton/noevia-rs crates/storage-path).
// Production decides with the Rust module alone (server/storage-path.cjs).
// Moved here from server/storage-path.cjs safeRelativePathJs, cleanRootJs, joinRootJs,
// isPlainFilenameJs (noevia-core 36376b2, the code the release before the retirement ran).

function safeRelativePathJs(raw) {
  const value = String(raw || '').trim().replace(/\\/g, '/');
  if (!value || value.length > 500) return '';
  if (value.startsWith('/')) return '';
  // #978: no filesystem or object store names a file with NUL; refuse it rather than pass it on.
  if (value.includes('\0')) return '';
  const segments = value.split('/').filter(Boolean);
  // #2125: the whole-value trim left white space on a last segment that a slash followed
  // ('Reports /' -> 'Reports '), which read back as 'Reports': trim the last segment's end too and
  // drop a last segment that is only white space. Inner segments are unchanged.
  while (segments.length) {
    const last = segments.pop().trimEnd();
    if (last) { segments.push(last); break; }
  }
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

module.exports = { safeRelativePathJs, cleanRootJs, joinRootJs, isPlainFilenameJs };
