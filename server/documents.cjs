'use strict';

const EXTRACT_CAP = 200_000; // compact project/RAG text, not the page store
const PAGE_TEXT_CAP = 200_000;
const TOTAL_TEXT_CAP = 2_000_000;
const PAGE_CAP = 300;
const ocr = require('./ocr.cjs');
const docling = require('./docling.cjs');
const native = require('./documents-native.cjs');

// Two extraction backends, chosen by configuration rather than by file:
//
//   DOCLING_BASE_URL set  — services/docling. Reading order, table structure,
//                           and the Office/ODF formats that used to be
//                           accepted and then silently produce empty content.
//   unset (default)       — the pdf.js walk below. PDF only, items in native
//                           order, no layout analysis.
//
// The default is unchanged on purpose. Docling needs a sidecar holding ~1.6 GB
// of models; an install that has not deployed it must keep working exactly as
// before, not degrade.
//
// The version string is the cache key: switching backends re-extracts
// everything, which is right, because the cached text came from a different
// pipeline.
const EXTRACTOR_VERSION = docling.enabled()
  ? 'docling-pages-v1:' + docling.VERSION
  : 'native-pages-v2' + (process.env.OCR_BASE_URL ? ':' + ocr.VERSION : '');

// What the UI and the upload routes will treat as an extractable document.
// This is the set that actually gets read — a format outside it is stored
// whole and honestly labelled, rather than accepted and quietly dropped.
const DOCUMENT_EXTENSIONS = new Set(['.pdf']);
// Both take the backend explicitly, because the gate and the backend must
// never disagree about what is readable: the first version read the env var
// here while extractDocumentText took the backend as an option, so a caller
// that asked for Docling was still refused .xlsx by the gate in front of it.
function isDocument(name, doclingEnabled = docling.enabled()) {
  return doclingEnabled ? docling.supports(name) : /\.pdf$/i.test(String(name || ''));
}
function documentExtensions(doclingEnabled = docling.enabled()) {
  return doclingEnabled ? [...docling.FORMATS] : [...DOCUMENT_EXTENSIONS];
}

// Assemble the shared return shape from per-page results. Both backends end
// here, so the state machine in document-sources.cjs sees one contract.
function assemble(pageTexts, totalPages, { retryable = false, error, extraTruncated = false } = {}) {
  const full = pageTexts.map(p => `[Page ${p.number}]\n${p.text || '(' + p.status + ')'}`).join('\n\n');
  const readable = pageTexts.some(p => p.text);
  const incomplete = pageTexts.some(p => !['native', 'blank', 'ocr'].includes(p.status)) || totalPages > PAGE_CAP;
  const truncated = full.length > EXTRACT_CAP || pageTexts.some(p => p.truncated) || totalPages > PAGE_CAP || extraTruncated;
  const state = !readable && incomplete ? 'failed' : incomplete || truncated ? 'partial' : 'ready';
  return { text: readable ? full.slice(0, EXTRACT_CAP) : '', pages: totalPages, pageTexts, truncated, state, retryable, error };
}

async function extractWithDocling(name, bytes, extractDocument) {
  let body;
  try {
    body = await extractDocument(name, bytes);
  } catch (err) {
    // A permanent failure (unreadable, unsupported) is a 422 to the caller, so
    // the original is stored and labelled. Anything else is retryable and must
    // NOT be cached as a failure — a busy worker is not a broken document.
    if (err && err.permanent) throw Object.assign(new Error(err.message), { status: 422 });
    // Nothing was extracted, so this is 'failed' outright. assemble() would
    // call an empty page list 'ready' — true for a document with no pages,
    // wrong for one that never got read. Say so explicitly rather than letting
    // a worker outage look like a clean empty result.
    return { ...assemble([], 0, { retryable: true }), state: 'failed',
      error: String(err.message || err).slice(0, 300) };
  }
  const pageTexts = body.pages.map(p => ({
    number: Number(p.number), text: String(p.text || ''), status: String(p.status || 'failed'),
    method: 'docling', truncated: !!p.truncated,
  }));
  return assemble(pageTexts, Number(body.total) || pageTexts.length, { extraTruncated: !!body.truncatedPages });
}

// Preserve native text and add separately labelled OCR for image-bearing pages.
async function extractDocumentText(name, bytes, {
  ocrEnabled = !!process.env.OCR_BASE_URL,
  extractPages = ocr.extractPages,
  doclingEnabled = docling.enabled(),
  extractDocument = docling.extractDocument,
  readPages = native.readInWorker,
} = {}) {
  if (!isDocument(name, doclingEnabled)) {
    throw Object.assign(new Error(`not a supported document (${documentExtensions(doclingEnabled).join(', ')})`), { status: 400 });
  }
  if (doclingEnabled) return extractWithDocling(name, bytes, extractDocument);
  // pdf.js runs in a worker with a time and a heap limit (documents-native.cjs): a pathological
  // PDF stops itself, not the server. A limit is as final as an unreadable file.
  let numPages, pageTexts;
  try {
    ({ numPages, pageTexts } = await readPages(bytes, { pageCap: PAGE_CAP, pageTextCap: PAGE_TEXT_CAP, totalTextCap: TOTAL_TEXT_CAP }));
  } catch (err) {
    const message = err.limit === 'time' ? 'Reading this PDF took too long, so it was stopped. Try a smaller or re-saved copy.'
      : err.limit === 'memory' ? 'Reading this PDF needed too much memory, so it was stopped. Try a smaller or re-saved copy.'
      : /password/i.test(err.message) ? 'Password-protected PDF; upload an unlocked copy.'
      : 'Could not parse this PDF: ' + String(err.message).slice(0, 200);
    throw Object.assign(new Error(message), { status: 422 });
  }
  // What the text caps still allow OCR to add, as the walk left it.
  let remaining = TOTAL_TEXT_CAP - pageTexts.reduce((n, p) => n + (p.text ? p.text.length : 0), 0);
  let retryable = false, ocrError;
  const candidates = pageTexts.filter(p => ['ocr-needed', 'unreadable'].includes(p.status));
  if (ocrEnabled && candidates.length) {
    try {
      const results = await extractPages(bytes, candidates.slice(0, 50).map(p => p.number));
      for (const p of candidates.slice(0, 50)) {
        const result = results.find(r => r.number === p.number);
        if (!result || result.error) { retryable = true; ocrError = result?.error || 'OCR response omitted pages; refresh to retry.'; continue; }
        const text = typeof result.text === 'string' ? result.text.trim() : '';
        if (!text) { p.status = 'unreadable'; continue; }
        const addition = `\n[OCR transcription — verify numbers against original]\n${text}`;
        const available = Math.max(0, Math.min(PAGE_TEXT_CAP - p.text.length, remaining));
        p.text += addition.slice(0, available);
        remaining -= Math.min(addition.length, available);
        p.truncated = !!result.truncated || addition.length > available;
        p.status = p.truncated ? 'truncated' : 'ocr';
        p.method = 'native+ocr';
      }
      if (candidates.length > 50) ocrError = 'OCR limited to 50 image-bearing pages per document.';
    } catch (err) { retryable = true; ocrError = String(err.message || err).slice(0, 300); }
  }
  const assembled = assemble(pageTexts, numPages, { retryable });
  return { ...assembled, error: ocrError || (assembled.state === 'failed' ? (ocrEnabled ? 'No readable text was recovered by OCR; try a clearer scan or an unlocked original.' : 'No readable native text. Scanned or image-based content needs OCR; OCR is not installed.') : undefined) };
}
module.exports = { isDocument, documentExtensions, extractDocumentText, DOCUMENT_EXTENSIONS, EXTRACT_CAP, EXTRACTOR_VERSION, PAGE_CAP, TOTAL_TEXT_CAP };
