'use strict';

// S3 ListObjectsV2 page scan (#976). An S3-compatible endpoint is user-configured and possibly
// hostile, so every page body is untrusted. `s3PageRecordsJs` is the reference implementation
// (moved here unchanged from storage-client.cjs's s3List); storage-client keeps the fetch, the
// signing and the paging. `s3-list-parse` (sbstndalton/noevia-rs, in the dav-parse.wasm module
// pinned by server/dav-parse.lock) is its Rust port.
//
// S3_PARSE_IMPL=js|wasm picks one (default js; any other value means js, with one warning).
// `wasm` FAILS CLOSED: a missing or tampered module, a refusal past the Rust caps, a trap or an
// unexpected reply throws, and the listing errors instead of falling back to the JS scan.

const davParseWasm = require('./dav-parse-wasm.cjs');
const { decodeXmlEntities, elementTexts, firstElementText } = require('./dav-listing.cjs');

/** One page listed with `prefix=queryPrefix&delimiter=/`: `{ records, truncated, next }` where
 *  records are `{ name, isDir, size }` (directories first; `size` the raw digit string or null),
 *  `truncated` whether <IsTruncated> says true, and `next` the decoded <NextContinuationToken> or
 *  null. */
function s3PageRecordsJs(body, queryPrefix) {
  const records = [];
  // Forward-only scans (elementTexts, #787): a hostile endpoint's body of unclosed tags cannot make
  // the old lazy regexes rescan the rest of the body from every opening tag (#833).
  // Keys and prefixes are XML text: decode &amp; and friends back to the real key (#845, as #787 did
  // for PROPFIND), or "a&b.md" lists as "a&amp;b.md" and 404s on read.
  for (const block of elementTexts(body, 'CommonPrefixes')) {
    const raw = firstElementText(block, 'Prefix');
    if (raw === undefined) continue;
    const full = decodeXmlEntities(raw).replace(/\/+$/, '');
    const rel = queryPrefix && full.startsWith(queryPrefix) ? full.slice(queryPrefix.length) : full;
    if (!rel) continue;
    records.push({ name: rel, isDir: true, size: null });
  }
  for (const block of elementTexts(body, 'Contents')) {
    const raw = firstElementText(block, 'Key');
    if (raw === undefined) continue;
    const full = decodeXmlEntities(raw);
    if (full.endsWith('/')) continue;
    const rel = queryPrefix && full.startsWith(queryPrefix) ? full.slice(queryPrefix.length) : full;
    if (!rel || rel.includes('/')) continue; // direct children only
    const sizeText = firstElementText(block, 'Size');
    records.push({ name: rel, isDir: false, size: sizeText !== undefined && /^\d+$/.test(sizeText) ? sizeText : null });
  }
  const truncated = firstElementText(body, 'IsTruncated');
  const next = firstElementText(body, 'NextContinuationToken');
  return { records, truncated: String(truncated).trim().toLowerCase() === 'true', next: next === undefined ? null : decodeXmlEntities(next) };
}

const PUBLIC_FAILURE = 'storage listing could not be read';
const IMPLS = new Set(['js', 'wasm']);
let warnedImpl = '';

/** S3_PARSE_IMPL, read per call so a test (or an owner flip plus restart) takes effect. */
function s3ParseImpl(env = process.env) {
  const raw = env.S3_PARSE_IMPL;
  if (raw === undefined || raw === '') return 'js';
  const value = String(raw).trim().toLowerCase();
  if (IMPLS.has(value)) return value;
  if (warnedImpl !== value) {
    warnedImpl = value;
    console.warn(`[storage] S3_PARSE_IMPL=${JSON.stringify(String(raw))} is not js or wasm; using js`);
  }
  return 'js';
}

/** The page as s3List consumes it, through the implementation S3_PARSE_IMPL picks. */
function s3Page(body, queryPrefix, { impl = s3ParseImpl() } = {}) {
  if (impl !== 'wasm') return s3PageRecordsJs(body, queryPrefix);
  try { return davParseWasm.s3ListPage(body, queryPrefix); } catch (err) {
    // Details (module path, checksums, refusal codes) stay in the server log: the message reaches
    // the browser in the browse 502 and is stored as a project source's failure reason.
    const reason = err instanceof davParseWasm.DavParseError ? err.reason : 'unexpected';
    console.warn(`[storage] s3-list-parse failed (${reason}): ${err?.message || err}`);
    throw Object.assign(new Error(PUBLIC_FAILURE), { status: 502, code: 's3_parse_failed', reason });
  }
}

module.exports = { s3PageRecordsJs, s3Page, s3ParseImpl, PUBLIC_FAILURE };
