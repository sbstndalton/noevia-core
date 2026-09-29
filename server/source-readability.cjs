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
  return !!(d && d.state === 'failed' && !String(file.content || '').trim());
}
const readable = (files) => (Array.isArray(files) ? files : []).filter((f) => !isUnreadable(f));
module.exports = { isUnreadable, readable };
