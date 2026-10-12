'use strict';
// A file's name is not ours to trust (#1588, #1605, #1606). The one place a name is quoted for the system text:
// JSON-quoted, then every code point JSON.stringify leaves raw but a reader or a model can treat as a line break or a
// display reorder is written as \uXXXX: U+0085 (NEL), U+2028, U+2029, the marks U+200E/U+200F, the embeddings and
// overrides U+202A-U+202E and the isolates U+2066-U+2069. A name can then neither start a line of its own nor be drawn
// as something else. (JSON.stringify itself already escapes ", \, U+0000-U+001F and lone surrogates.)
const RAW = /[\u0085\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/g;
const escapeCode = (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0');

/** One name, quoted and escaped. */
const quoteName = (name) => JSON.stringify(String(name)).replace(RAW, escapeCode);
/** A list of names, each quoted and escaped, joined with ", ". */
const quotedNames = (names) => names.map(quoteName).join(', ');

module.exports = { quoteName, quotedNames };
