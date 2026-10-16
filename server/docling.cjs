'use strict';
const { readCappedJson } = require('./http.cjs');
const workers = require('./document-workers.cjs');
const { uploadInit } = require('./upload-body.cjs');
// Client for the private Docling worker (services/docling). Only the
// operator-configured worker receives bytes, never a model or a cloud API —
// same rule as ocr.cjs, and the same shape, deliberately.
//
// The version string is part of the extractor cache key in documents.cjs: a
// change here re-extracts every document, which is what should happen when the
// pipeline that produced the cached text changes.
// v3 (#700): pages Docling returned empty fall back to the PDF's own text layer and come back
// 'degraded'. Bumped so documents cached with such a page as 'blank' are read again — which
// only helps once the docling image carrying the fallback is running; deploy that first.
const VERSION = 'docling-2.129-layout-tableformer-tesseract-v3-native-fallback';

// Formats the worker accepts. Kept in sync with SUPPORTED in
// services/docling/extract.py — the worker is authoritative and re-checks,
// answering 415 for anything it cannot read, but knowing here avoids sending
// 25 MB across the wire to be told no.
const FORMATS = new Set(['.pdf', '.docx', '.pptx', '.xlsx', '.odt', '.odp', '.ods',
  '.html', '.htm', '.md', '.epub', '.csv', '.png', '.jpg', '.jpeg', '.tiff', '.tif', '.bmp']);

function supports(name) {
  const match = /\.[a-z0-9]+$/i.exec(String(name || ''));
  return !!match && FORMATS.has(match[0].toLowerCase());
}

// #1841: a machine Docling is assigned to counts, else DOCLING_BASE_URL (document-workers.cjs).
function enabled() { return workers.configured('documents'); }

/** The last path segment, which is all the worker needs and all it will accept. */
function documentName(name) {
  const last = String(name || '').split(/[\\/]/).pop() || 'document';
  // 200 is the worker's own limit; keep the end, because that is where the suffix is.
  return last.length > 200 ? last.slice(-200) : last;
}

/**
 * Header values are ByteStrings (fetch/undici): a name outside Latin-1 — any
 * storage path can carry one, since names come from whatever the user or
 * their storage server calls a file — throws a TypeError before a byte
 * reaches the network, not an HTTP error the retry/permanent split below
 * knows how to read. Percent-encoding keeps the trailing dot-suffix intact
 * (server.py reads only that) and is always representable as a header value.
 */
function headerSafeName(name) {
  // A raw header value must never carry a control character: undici (and any
  // spec-compliant HTTP client) throws a TypeError on CR, LF, NUL, DEL and
  // similar bytes below 0x20 or at 0x7f, not just on anything outside
  // Latin-1. Encode the whole name whenever one of those sneaks in, rather
  // than passing it through and letting the request itself throw.
  const safe = /^[\x20-\x7e\x80-\xff\t]*$/.test(name) ? name : encodeURIComponent(name);
  return safe.length > 200 ? safe.slice(-200) : safe;
}

// #1726: `figures` asks the worker for the document's figures (images) as well, and for a per-page `ocr`
// marker (the page had no text layer, so its text came from OCR). Only sent while NOEVIA_MULTIMODAL_RAG
// is on (documents.cjs); without the header the worker answers exactly as before.
// #1864: `pages: [first, last]` asks for those pages only (X-Document-Pages), which is how a large PDF is
// read range by range; the reply's `total` is still the whole document's page count. A reply holding a
// page outside the range came from a worker that ignores the header (an image from before #1864): that
// is an error with `code: 'no-ranges'`, never a result. Without `pages` the request is exactly as before.
async function extractDocument(name, bytes, options = {}) {
  const { figures = false } = options;
  const range = rangeOf(options.pages);
  const target = workers.resolve('documents');
  const url = options.url === undefined ? target.url : options.url;
  const fetchImpl = options.fetchImpl || (options.url === undefined ? target.fetch : fetch);
  if (!url) throw new Error('Document extraction is not configured.');
  const response = await fetchImpl(`${url.replace(/\/+$/, '')}/extract`, uploadInit(bytes, {
    method: 'POST',
    redirect: 'error',
    // The worker reads the suffix and nothing else, and refuses a name that could be a path —
    // rightly, since it must never treat one as a path. noevia's own names ARE paths
    // ("Documents/Tax Return 2024/W-2.pdf"), so send the last segment. Sending the whole path
    // made every document in a folder fail with HTTP 400 while a bare filename worked, which
    // is why a synthetic test did not catch it (2026-09-21).
    headers: { 'Content-Type': 'application/octet-stream', 'X-Document-Name': headerSafeName(documentName(name)), ...(figures ? { 'X-Document-Figures': '1' } : {}),
      ...(range ? { 'X-Document-Pages': `${range[0]}-${range[1]}` } : {}) },
    // #1885: a SAB-backed read goes as a sized stream (upload-body.cjs).
    // Measured on DaServer (2 CPUs, CPU-only torch), not assumed:
    //   scanned prose, OCR   3.4 s/page
    //   table-heavy native   10.9 s/page  <- TableFormer, not OCR, is the cost
    // The worker converts at most PAGE_CAP (300) pages, so the worst case this
    // has to survive is 300 x 10.9 s ~= 55 min. The previous 610 s (~10 min)
    // covered barely a fifth of that and would abort a large document the
    // worker was still successfully converting, which surfaces as a retryable
    // failure and then fails again identically on retry.
    // A range is bounded by its own length instead (#1864): two minutes plus a minute a page, five
    // times the measured worst case per page, and never more than the whole-document limit.
    signal: AbortSignal.timeout(range ? Math.min(3900000, 120000 + (range[1] - range[0] + 1) * 60000) : 3900000),
  }));
  if (!response.ok) {
    // 503 and 415 are the two a user can act on, so they say something useful;
    // everything else is a retry.
    if (response.status === 503) throw Object.assign(new Error('Document extraction is busy; refresh to retry.'), { status: 503 });
    // A 400 means noevia sent something the worker refuses — a bug on this side, not a broken
    // document. Named as that rather than as an outage, but deliberately NOT permanent: a
    // cached refusal would outlive the fix, and the fix is what should heal it.
    if (response.status === 400) throw new Error('noevia sent this document in a form the extractor refused; it will be read again after the next update.');
    if (response.status === 415) throw Object.assign(new Error(`This file type cannot be read yet; the original is stored.`), { permanent: true });
    if (response.status === 422) throw Object.assign(new Error('This document could not be read; the original is stored.'), { permanent: true });
    throw new Error(`Document extraction unavailable (HTTP ${response.status}); refresh to retry.`);
  }
  // The worker returns at most TOTAL_TEXT_CAP (2,000,000 characters, services/docling/extract.py) of
  // text plus per-page metadata; 32 MB is far above that (#920).
  const body = await readCappedJson(response, DOCLING_REPLY_CAP).catch((e) => { throw e?.code === 'too_large' ? new Error('Invalid extraction response; refresh to retry.') : e; });
  if (!body || !Array.isArray(body.pages)) throw new Error('Invalid extraction response; refresh to retry.');
  if (range && body.pages.some((p) => !(Number(p?.number) >= range[0] && Number(p?.number) <= range[1]))) {
    throw Object.assign(new Error('The document extractor does not read page ranges yet; update the docling service.'), { code: 'no-ranges' });
  }
  return body;
}

/** [first, last] for a valid page range, else null. */
function rangeOf(pages) {
  if (!Array.isArray(pages) || pages.length !== 2) return null;
  const [first, last] = pages.map(Number);
  return Number.isSafeInteger(first) && Number.isSafeInteger(last) && first >= 1 && last >= first && last - first < 200 ? [first, last] : null;
}

const DOCLING_REPLY_CAP = 32 * 1024 * 1024;

// #1864: whether the worker reads page ranges, from its /health (`"ranges": true` since #1864). Asked
// before any ranged request, because a worker from before #1864 ignores X-Document-Pages and would
// convert the whole first window again only for the reply to be thrown away. true, false, or null when
// the worker could not be asked. #1882: with `bytes`, false when the file is over the worker's advertised
// `rangedMaxBytes` (it would refuse every range with 400). Positive and negative answers are kept
// CAPABILITY_TTL_MS.
const CAPABILITY_TTL_MS = 5 * 60_000;
let rangesCache = { at: 0, url: null, value: undefined };
async function rangesHealth(options) {
  const target = workers.resolve('documents');
  const url = options.url === undefined ? target.url : options.url;
  const fetchImpl = options.fetchImpl || (options.url === undefined ? target.fetch : fetch);
  if (!url) return null;
  const now = Date.now();
  if (!options.fresh && rangesCache.url === url && rangesCache.value !== undefined && now - rangesCache.at < CAPABILITY_TTL_MS) return rangesCache.value;
  let value = null;
  try {
    const response = await fetchImpl(`${url.replace(/\/+$/, '')}/health`, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if (response.ok) {
      const body = await readCappedJson(response, 64 * 1024);
      value = { ranges: body?.ranges === true,
        ...(Number.isSafeInteger(body?.rangedMaxBytes) && body.rangedMaxBytes > 0 ? { rangedMaxBytes: body.rangedMaxBytes } : {}) };
    }
  } catch { value = null; }
  rangesCache = { at: now, url, value };
  return value;
}
async function rangesSupported(options = {}) {
  const health = await rangesHealth(options);
  if (!health) return null;
  if (!health.ranges) return false;
  return !(Number.isSafeInteger(options.bytes) && health.rangedMaxBytes && options.bytes > health.rangedMaxBytes);
}

module.exports = { CAPABILITY_TTL_MS, extractDocument, rangesSupported, supports, enabled, documentName, headerSafeName, VERSION, FORMATS };
