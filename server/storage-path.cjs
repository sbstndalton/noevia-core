'use strict';

// Storage path rules (#978): the guards every request-supplied storage path and upload filename
// passes through. Moved here unchanged from storage-client.cjs (safeRelativePath, cleanRoot,
// joinRoot) and uploads.cjs validate (the plain-filename rule). One deliberate tightening since the
// move: safeRelativePath refuses a path containing NUL.

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

module.exports = {
  safeRelativePath: safeRelativePathJs, cleanRoot: cleanRootJs, joinRoot: joinRootJs, isPlainFilename: isPlainFilenameJs,
  safeRelativePathJs, cleanRootJs, joinRootJs, isPlainFilenameJs,
};
