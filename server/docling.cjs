'use strict';
// Client for the private Docling worker (services/docling). Only the
// operator-configured worker receives bytes, never a model or a cloud API —
// same rule as ocr.cjs, and the same shape, deliberately.
//
// The version string is part of the extractor cache key in documents.cjs: a
// change here re-extracts every document, which is what should happen when the
// pipeline that produced the cached text changes.
const VERSION = 'docling-2.129-layout-tableformer-tesseract-v2';

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

function enabled() { return !!process.env.DOCLING_BASE_URL; }

/** The last path segment, which is all the worker needs and all it will accept. */
function documentName(name) {
  const last = String(name || '').split(/[\\/]/).pop() || 'document';
  // 200 is the worker's own limit; keep the end, because that is where the suffix is.
  return last.length > 200 ? last.slice(-200) : last;
}

async function extractDocument(name, bytes, { url = process.env.DOCLING_BASE_URL, fetchImpl = fetch } = {}) {
  if (!url) throw new Error('Document extraction is not configured.');
  const response = await fetchImpl(`${url.replace(/\/+$/, '')}/extract`, {
    method: 'POST',
    redirect: 'error',
    // The worker reads the suffix and nothing else, and refuses a name that could be a path —
    // rightly, since it must never treat one as a path. noevia's own names ARE paths
    // ("Documents/Tax Return 2024/W-2.pdf"), so send the last segment. Sending the whole path
    // made every document in a folder fail with HTTP 400 while a bare filename worked, which
    // is why a synthetic test did not catch it (2026-09-21).
    headers: { 'Content-Type': 'application/octet-stream', 'X-Document-Name': documentName(name) },
    body: bytes,
    // Measured on DaServer (2 CPUs, CPU-only torch), not assumed:
    //   scanned prose, OCR   3.4 s/page
    //   table-heavy native   10.9 s/page  <- TableFormer, not OCR, is the cost
    // The worker converts at most PAGE_CAP (300) pages, so the worst case this
    // has to survive is 300 x 10.9 s ~= 55 min. The previous 610 s (~10 min)
    // covered barely a fifth of that and would abort a large document the
    // worker was still successfully converting, which surfaces as a retryable
    // failure and then fails again identically on retry.
    signal: AbortSignal.timeout(3900000),
  });
  if (!response.ok) {
    // 503 and 415 are the two a user can act on, so they say something useful;
    // everything else is a retry.
    if (response.status === 503) throw new Error('Document extraction is busy; refresh to retry.');
    // A 400 means noevia sent something the worker refuses — a bug on this side, not a broken
    // document. Named as that rather than as an outage, but deliberately NOT permanent: a
    // cached refusal would outlive the fix, and the fix is what should heal it.
    if (response.status === 400) throw new Error('noevia sent this document in a form the extractor refused; it will be read again after the next update.');
    if (response.status === 415) throw Object.assign(new Error(`This file type cannot be read yet; the original is stored.`), { permanent: true });
    if (response.status === 422) throw Object.assign(new Error('This document could not be read; the original is stored.'), { permanent: true });
    throw new Error(`Document extraction unavailable (HTTP ${response.status}); refresh to retry.`);
  }
  const body = await response.json();
  if (!body || !Array.isArray(body.pages)) throw new Error('Invalid extraction response; refresh to retry.');
  return body;
}

module.exports = { extractDocument, supports, enabled, documentName, VERSION, FORMATS };
