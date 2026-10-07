'use strict';

// S3 ListObjectsV2 page scan (#976). An S3-compatible endpoint is user-configured and possibly
// hostile, so every page body is untrusted. `s3PageRecordsJs` is the reference implementation
// (moved here unchanged from storage-client.cjs's s3List); storage-client keeps the fetch, the
// signing and the paging.

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

const s3Page = s3PageRecordsJs;

module.exports = { s3PageRecordsJs, s3Page };
