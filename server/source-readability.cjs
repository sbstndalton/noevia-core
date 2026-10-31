'use strict';
// A source whose text could not be read (#586): an upload the reader rejected (binary data behind a
// .txt name, a PDF that failed extraction) is kept as an original the user can download, but it is
// not a text source. It must never be indexed, offered to the model, counted as a readable source or
// cited in a reply. The browser mirrors this predicate in src/source-status.ts (isUnreadableSource).
function isUnreadable(file) {
  if (!file || typeof file !== 'object') return false;
  const a = file.attachment, d = file.document;
  if (a && a.state === 'stored' && (a.group === 'Text' || a.group === 'Documents')) return true;
  // A failed refresh that still has earlier text is "using previous text", which is readable.
  const blank = !String(file.content || '').trim();
  // A document waiting for its reader (#2237: state 'queued') with no earlier text has nothing to offer yet.
  return !!(d && (d.state === 'failed' || d.state === 'queued') && blank);
}
// A document the service that reads it has not read yet (#2237): kept, and read when the service is back. Unlike a
// failed read it is not final, and the model must not take its empty text for the document's content.
function isWaiting(file) {
  const d = file && typeof file === 'object' ? file.document : null;
  return !!(d && d.state === 'queued' && !String(file.content || '').trim());
}
// The line a chat turn adds when project documents are waiting to be read (#2237), or '' when none are.
function waitingNotice(files) {
  const names = (Array.isArray(files) ? files : []).filter(isWaiting).map((f) => String(f.name)).slice(0, 10);
  if (!names.length) return '';
  return `${names.map((n) => JSON.stringify(n)).join(', ')} ${names.length === 1 ? 'is' : 'are'} waiting to be read (document reading is not available yet), so ${names.length === 1 ? 'its' : 'their'} contents are not available to you. Say so if asked about ${names.length === 1 ? 'it' : 'them'}; do not guess at the contents or call ${names.length === 1 ? 'it' : 'them'} empty.`;
}
const readable = (files) => (Array.isArray(files) ? files : []).filter((f) => !isUnreadable(f));
module.exports = { isUnreadable, isWaiting, waitingNotice, readable };
