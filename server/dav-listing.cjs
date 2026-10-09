'use strict';

// PROPFIND (Depth: 1) listing parser for the storage browser (#787, #967).
//
// A multistatus body comes from a server the user (or an administrator) configured, so it is
// untrusted input. `dav-parse.wasm`, built from sbstndalton/noevia-rs crates/dav-parse at the ref
// pinned in server/dav-parse.lock, parses it (always, since #1071; it was DAV_PARSE_IMPL=wasm).
// It FAILS CLOSED: a missing or tampered module stops startup, and a refusal past the Rust caps,
// a trap or an unexpected reply throws, so the listing errors. The JS reference parser is a test
// oracle only (tests/server/oracle/dav-listing.cjs). The XML helpers below are also used by
// storage-client.cjs (removeEmptyFolder) and the S3 scan.

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

const PUBLIC_FAILURE = 'storage listing could not be read';

/** The listing as storage-client's davList used to build it inline: `{ name, isDir, size }` with
 *  `size` a Number or null. Rust only: a missing or tampered module is stopped at startup, and a
 *  refusal past the Rust caps, a trap or an unexpected reply throws here, so the listing errors. */
function listingEntries(body, target) {
  let records;
  try { records = davParseWasm.listRecords(body, target); } catch (err) {
    // Details (module path, checksums, refusal codes) stay in the server log: the message reaches
    // the browser in the browse 502 and is stored as a project source's failure reason.
    const reason = err instanceof davParseWasm.DavParseError ? err.reason : 'unexpected';
    console.warn(`[storage] dav-parse failed (${reason}): ${err?.message || err}`);
    throw Object.assign(new Error(PUBLIC_FAILURE), { status: 502, code: 'dav_parse_failed', reason });
  }
  return records.map((r) => ({ name: r.name, isDir: r.isDir, size: r.size === null ? null : Number(r.size) }));
}

module.exports = { decodeXmlEntities, elementTexts, firstElementText, listingEntries, PUBLIC_FAILURE };
