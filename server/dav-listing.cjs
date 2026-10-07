'use strict';

// PROPFIND (Depth: 1) listing parser for the storage browser (#787, #967).
//
// A multistatus body comes from a server the user (or an administrator) configured, so it is
// untrusted input. `listingRecordsJs` is the reference implementation (moved here unchanged from
// storage-client.cjs's davList); `dav-parse.wasm`, built from sbstndalton/noevia-rs
// crates/dav-parse at the ref pinned in server/dav-parse.lock, is its Rust port.
//
// DAV_PARSE_IMPL=js|wasm picks one (default js; any other value means js, with one warning).
// `wasm` FAILS CLOSED: a missing or tampered module, a refusal past the Rust caps, a trap or an
// unexpected reply throws, and the listing errors instead of falling back to the JS parser.

const davParseWasm = require('./dav-parse-wasm.cjs');

// PROPFIND <href> text is XML-escaped (&amp; &lt; &gt; &quot; &apos; and numeric refs like &#38;);
// it has to be decoded back to the real path before parsing as a URL, or an escaped name (e.g.
// "a&b.md" sent as "a&amp;b.md") lists under the escaped spelling and 404s on every read.
function decodeXmlEntities(s) {
  return String(s).replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, ent) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      // A hostile body can name a code point String.fromCodePoint refuses (out of range, or a
      // lone surrogate): leave the original text alone rather than throwing and losing the listing.
      const valid = Number.isFinite(code) && code > 0 && code <= 0x10FFFF && !(code >= 0xD800 && code <= 0xDFFF);
      return valid ? String.fromCodePoint(code) : m;
    }
    switch (ent) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      default: return m;
    }
  });
}

// ── PROPFIND parsing (#787) ───────────────────────────────────────────────────
// The old lazy `<response>([\s\S]*?)</response>` regex rescanned to the end of the body from every
// unclosed opening tag, which is quadratic on a hostile body and blocks the event loop for every
// tenant. These scans move forward only.

const isTagNameChar = (code) => (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);

/** At `i` (a '<'), the index just past `<[prefix:]name>` (or `</[prefix:]name>` when
 *  `closing`), else -1. The prefix is the same [A-Za-z0-9]+ the old patterns accepted. */
function tagEndAt(body, i, name, closing) {
  let j = i + 1;
  if (closing) { if (body.charCodeAt(j) !== 47 /* / */) return -1; j++; }
  let k = j;
  while (k < body.length && isTagNameChar(body.charCodeAt(k))) k++;
  if (k > j && body.charCodeAt(k) === 58 /* : */) j = k + 1;
  return body.startsWith(name, j) && body.charCodeAt(j + name.length) === 62 /* > */ ? j + name.length + 1 : -1;
}

/** The text inside each `<[p:]name>…</[p:]name>` in `body`, in order, at most `limit` of them.
 *  Same matches as the lazy regex (nearest closing tag wins, any prefix on either side), in
 *  time linear in the body: once no closing tag follows an opening one, none can follow a
 *  later opening one either, so the scan stops. */
function elementTexts(body, name, limit = Infinity) {
  const out = [];
  const text = String(body);
  let pos = 0;
  while (out.length < limit) {
    let start = -1;
    for (let i = text.indexOf('<', pos); i !== -1; i = text.indexOf('<', i + 1)) {
      const end = tagEndAt(text, i, name, false);
      if (end !== -1) { start = end; break; }
    }
    if (start === -1) break;
    let close = -1, after = -1;
    for (let i = text.indexOf('</', start); i !== -1; i = text.indexOf('</', i + 2)) {
      const end = tagEndAt(text, i, name, true);
      if (end !== -1) { close = i; after = end; break; }
    }
    if (close === -1) break;
    out.push(text.slice(start, close));
    pos = after;
  }
  return out;
}
const firstElementText = (body, name) => elementTexts(body, name, 1)[0];

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

const PUBLIC_FAILURE = 'storage listing could not be read';
const IMPLS = new Set(['js', 'wasm']);
let warnedImpl = '';

/** DAV_PARSE_IMPL, read per call so a test (or an owner flip plus restart) takes effect. */
function davParseImpl(env = process.env) {
  const raw = env.DAV_PARSE_IMPL;
  if (raw === undefined || raw === '') return 'js';
  const value = String(raw).trim().toLowerCase();
  if (IMPLS.has(value)) return value;
  if (warnedImpl !== value) {
    warnedImpl = value;
    console.warn(`[storage] DAV_PARSE_IMPL=${JSON.stringify(String(raw))} is not js or wasm; using js`);
  }
  return 'js';
}

/** The listing as storage-client's davList used to build it inline: `{ name, isDir, size }` with
 *  `size` a Number or null. */
function listingEntries(body, target, { impl = davParseImpl() } = {}) {
  let records;
  if (impl === 'wasm') {
    try { records = davParseWasm.listRecords(body, target); } catch (err) {
      // Details (module path, checksums, refusal codes) stay in the server log: the message reaches
      // the browser in the browse 502 and is stored as a project source's failure reason.
      const reason = err instanceof davParseWasm.DavParseError ? err.reason : 'unexpected';
      console.warn(`[storage] dav-parse failed (${reason}): ${err?.message || err}`);
      throw Object.assign(new Error(PUBLIC_FAILURE), { status: 502, code: 'dav_parse_failed', reason });
    }
  } else records = listingRecordsJs(body, target);
  return records.map((r) => ({ name: r.name, isDir: r.isDir, size: r.size === null ? null : Number(r.size) }));
}

module.exports = { isListableName, decodeXmlEntities, elementTexts, firstElementText, listingRecordsJs, listingEntries, davParseImpl, PUBLIC_FAILURE };
