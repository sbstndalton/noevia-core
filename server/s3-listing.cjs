'use strict';

// S3 ListObjectsV2 page scan (#976). An S3-compatible endpoint is user-configured and possibly
// hostile, so every page body is untrusted. `s3-list-parse` (sbstndalton/noevia-rs, in the
// dav-parse.wasm module pinned by server/dav-parse.lock) scans it, always (since #1071; it was
// S3_PARSE_IMPL=wasm); storage-client keeps the fetch, the signing and the paging.
//
// It FAILS CLOSED: a missing or tampered module stops startup, and a refusal past the Rust caps,
// a trap or an unexpected reply throws, so the listing errors. The JS reference scan is a test
// oracle only (tests/server/oracle/s3-listing.cjs).

const davParseWasm = require('./dav-parse-wasm.cjs');

const PUBLIC_FAILURE = 'storage listing could not be read';

/** One page listed with `prefix=queryPrefix&delimiter=/`: `{ records, truncated, next }` where
 *  records are `{ name, isDir, size }` (directories first; `size` the raw digit string or null),
 *  `truncated` whether <IsTruncated> says true, and `next` the decoded <NextContinuationToken> or
 *  null. */
function s3Page(body, queryPrefix) {
  try { return davParseWasm.s3ListPage(body, queryPrefix); } catch (err) {
    // Details (module path, checksums, refusal codes) stay in the server log: the message reaches
    // the browser in the browse 502 and is stored as a project source's failure reason.
    const reason = err instanceof davParseWasm.DavParseError ? err.reason : 'unexpected';
    console.warn(`[storage] s3-list-parse failed (${reason}): ${err?.message || err}`);
    throw Object.assign(new Error(PUBLIC_FAILURE), { status: 502, code: 's3_parse_failed', reason });
  }
}

module.exports = { s3Page, PUBLIC_FAILURE };
