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

async function extractDocument(name, bytes, { url = process.env.DOCLING_BASE_URL, fetchImpl = fetch } = {}) {
  if (!url) throw new Error('Document extraction is not configured.');
  const response = await fetchImpl(`${url.replace(/\/+$/, '')}/extract`, {
    method: 'POST',
    redirect: 'error',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Document-Name': String(name).slice(0, 200) },
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
    if (response.status === 415) throw Object.assign(new Error(`This file type cannot be read yet; the original is stored.`), { permanent: true });
    if (response.status === 422) throw Object.assign(new Error('This document could not be read; the original is stored.'), { permanent: true });
    throw new Error(`Document extraction unavailable (HTTP ${response.status}); refresh to retry.`);
  }
  const body = await response.json();
  if (!body || !Array.isArray(body.pages)) throw new Error('Invalid extraction response; refresh to retry.');
  return body;
}

module.exports = { extractDocument, supports, enabled, VERSION, FORMATS };
