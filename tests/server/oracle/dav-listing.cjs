'use strict';

// TEST ORACLE (#1071): never required by production code (server/oracle-isolation.test.cjs
// enforces that). The JS reference for the PROPFIND listing parser, kept only so
// tools/gen-dav-listing-fixtures.cjs can regenerate tests/fixtures/dav-listing.v1.json and the
// differential tests can compare it with dav-parse.wasm (sbstndalton/noevia-rs crates/dav-parse).
// Production parses with the Rust module alone (server/dav-listing.cjs).
// Moved here unchanged from server/dav-listing.cjs listingRecordsJs.

const { elementTexts, firstElementText, decodeXmlEntities } = require('../../../server/dav-listing.cjs');

/** The direct children of the directory at `target` (the PROPFIND request URL) in a multistatus
 *  `body`, in body order: `{ name, isDir, size }` with `size` the raw digit string or null.
 *  Throws (as `new URL`/`decodeURIComponent` do) when `target` itself is unusable. */
// A listed name must be safe to show and to read back by that exact name (#969-#971). Hostile
// entries are SKIPPED, never rewritten (a rewritten name could make a later read target a different
// file) and never fail the whole listing (one bad entry should not hide the rest, matching how a
// foreign href was already skipped):
//   - an absolute href on another origin (scheme, host or port differs from the request URL);
//   - a name that is `.` or `..` after decoding (e.g. `..%2f`), or contains `/` or `\`;
//   - a name with NUL, C0/C1 controls, DEL, or a bidi control (U+202A-U+202E, U+2066-U+2069,
//     U+200E, U+200F, U+061C).
const FORBIDDEN_NAME_CHAR = /[\u0000-\u001f\u007f-\u009f\\\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
function isListableName(name) {
  return name !== '.' && name !== '..' && !name.includes('/') && !FORBIDDEN_NAME_CHAR.test(name);
}
/** Same origin as WHATWG URL defines it for http(s): scheme, host and (default-normalised) port.
 *  Compared field by field so opaque origins (file:, javascript:, ...) never match each other. */
const sameOrigin = (a, b) => a.protocol === b.protocol && a.hostname === b.hostname && a.port === b.port
  && (a.protocol === 'http:' || a.protocol === 'https:');

function listingRecordsJs(body, target) {
  const records = [];
  const base = new URL(target);
  const requestDir = decodeURIComponent(base.pathname).replace(/\/+$/, '');
  for (const block of elementTexts(body, 'response')) {
    const hrefText = firstElementText(block, 'href');
    if (hrefText === undefined) continue;
    let href;
    try {
      const resolved = new URL(decodeXmlEntities(hrefText).trim(), target);
      if (!sameOrigin(resolved, base)) continue; // #969: a foreign origin, whatever its path
      href = decodeURIComponent(resolved.pathname).replace(/\/+$/, '');
    } catch { continue; }
    if (href !== requestDir && !href.startsWith(`${requestDir}/`)) continue; // a foreign href: not under the browsed directory
    const relative = href.slice(requestDir.length + 1);
    if (!relative || relative.includes('/')) continue; // direct children only
    if (!isListableName(relative)) continue; // #970/#971: dot segment, backslash, control or bidi
    const isDir = /<(?:[a-zA-Z0-9]+:)?collection\s*\/?>/.test(block);
    const sizeMatch = block.match(/<(?:[a-zA-Z0-9]+:)?getcontentlength>(\d+)</);
    records.push({ name: relative, isDir, size: sizeMatch ? sizeMatch[1] : null });
  }
  return records;
}

module.exports = { listingRecordsJs, isListableName };
