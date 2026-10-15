'use strict';

const EXTRACT_CAP = 200_000; // compact project/RAG text, not the page store
const PAGE_TEXT_CAP = 200_000;
const TOTAL_TEXT_CAP = 2_000_000;
const PAGE_CAP = 300;
const ocr = require('./ocr.cjs');
const docling = require('./docling.cjs');
const workers = require('./document-workers.cjs');
const native = require('./documents-native.cjs');
const multimodal = require('./multimodal-rag.cjs');

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
// #1726: with multimodal RAG on, Docling also returns figures, so a document read without them is read
// again (the suffix). Off, the version is exactly what it was.
// #1841: read at call time, not at load, because Settings → Inference machines can assign OCR or Docling to a
// machine while the process runs. Nothing assigned: the same values the environment gave at load.
const figuresOn = () => docling.enabled() && multimodal.enabled();
const extractorVersion = () => docling.enabled()
  ? 'docling-pages-v1:' + docling.VERSION + (figuresOn() ? ':figures-v1' : '')
  : 'native-pages-v2' + (workers.configured('ocr') ? ':' + ocr.VERSION : '');

// What the UI and the upload routes will treat as an extractable document.
// This is the set that actually gets read — a format outside it is stored
// whole and honestly labelled, rather than accepted and quietly dropped.
const DOCUMENT_EXTENSIONS = new Set(['.pdf']);
// Both take the backend explicitly, because the gate and the backend must
// never disagree about what is readable: the first version read the env var
// here while extractDocumentText took the backend as an option, so a caller
// that asked for Docling was still refused .xlsx by the gate in front of it.
// Text-like files are read as text by the upload path, never sent to an extractor.
// Docling lists .md and .csv as inputs, but its Markdown reader rejects ordinary
// Markdown (including SKILL.md), which left the file stored as "Not readable" (#577).
const PLAIN_TEXT = /\.(txt|md|markdown|csv|json|ya?ml|ts|tsx|js|jsx|py|sh|css)$/i;
function isDocument(name, doclingEnabled = docling.enabled()) {
  if (PLAIN_TEXT.test(String(name || ''))) return false;
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

async function extractWithDocling(name, bytes, extractDocument, figures = false) {
  let body;
  try {
    body = figures ? await extractDocument(name, bytes, { figures: true }) : await extractDocument(name, bytes);
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
  // A 'degraded' page (#700) is one Docling left (near-)empty whose text came from the PDF's own
  // text layer instead. It is readable — its text is in `full` and reaches retrieval — but it is
  // not in the complete set, so the document is 'partial', never plain ready.
  const pageTexts = body.pages.map(p => ({
    number: Number(p.number), text: String(p.text || ''), status: String(p.status || 'failed'),
    method: p.method === 'pdfium' ? 'pdfium' : 'docling', truncated: !!p.truncated,
    ...(typeof p.reason === 'string' && /^[a-z-]{1,40}$/.test(p.reason) ? { reason: p.reason } : {}),
    // #1726: the worker's scanned-page marker (sent only when figures were asked for).
    ...(figures && p.ocr === true ? { ocr: true } : {}),
  }));
  const out = assemble(pageTexts, Number(body.total) || pageTexts.length, { extraTruncated: !!body.truncatedPages });
  if (!figures) return out;
  const found = parseFigures(body.figures, pageTexts);
  return found.length ? { ...out, figures: found } : out;
}

// #1726: the figures a Docling reply carries, checked: at most FIGURE_CAP, each a PNG, JPEG or WebP whose
// bytes are what its type says, at most FIGURE_BYTES, on a page of this document, never on a scanned
// page (multimodal-rag.cjs scannedPage). Anything else is dropped, not trusted.
const FIGURE_CAP = 64;
const FIGURE_BYTES = 4 * 1024 * 1024;
const FIGURE_TYPES = { 'image/png': { ext: 'png', magic: (b) => b.length > 8 && b.readUInt32BE(0) === 0x89504e47 },
  'image/jpeg': { ext: 'jpg', magic: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/webp': { ext: 'webp', magic: (b) => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP' } };
function parseFigures(list, pageTexts) {
  if (!Array.isArray(list)) return [];
  const pages = new Map(pageTexts.map((p) => [p.number, p]));
  const out = [];
  for (const f of list.slice(0, FIGURE_CAP)) {
    const type = FIGURE_TYPES[f?.mime];
    const page = Number(f?.page), index = Number(f?.index);
    if (!type || !Number.isInteger(page) || !pages.has(page) || !Number.isInteger(index) || index < 0 || index > 999) continue;
    if (multimodal.scannedPage(pages.get(page))) continue;
    if (typeof f.data !== 'string' || f.data.length > Math.ceil(FIGURE_BYTES / 3) * 4 + 4) continue;
    const bytes = Buffer.from(f.data, 'base64');
    if (!bytes.length || bytes.length > FIGURE_BYTES || !type.magic(bytes)) continue;
    out.push({ page, index, mime: f.mime, ext: type.ext, bytes,
      ...(typeof f.caption === 'string' && f.caption.trim() ? { caption: f.caption.trim().slice(0, 300) } : {}),
      ...(typeof f.text === 'string' && f.text.trim() ? { text: f.text.trim().slice(0, 4000) } : {}) });
  }
  return out;
}

// Preserve native text and add separately labelled OCR for image-bearing pages.
async function extractDocumentText(name, bytes, {
  ocrEnabled = workers.configured('ocr'),
  extractPages = ocr.extractPages,
  doclingEnabled = docling.enabled(),
  extractDocument = docling.extractDocument,
  readPages = native.readInWorker,
  figures = figuresOn(),
} = {}) {
  if (!isDocument(name, doclingEnabled)) {
    throw Object.assign(new Error(`not a supported document (${documentExtensions(doclingEnabled).join(', ')})`), { status: 400 });
  }
  if (doclingEnabled) return extractWithDocling(name, bytes, extractDocument, figures);
  // pdf.js runs in a worker with a time and a heap limit (documents-native.cjs): a pathological
  // PDF stops itself, not the server. A limit is as final as an unreadable file.
  let numPages, pageTexts;
  try {
    ({ numPages, pageTexts } = await readPages(bytes, { pageCap: PAGE_CAP, pageTextCap: PAGE_TEXT_CAP, totalTextCap: TOTAL_TEXT_CAP }));
  } catch (err) {
    if (err.limit === 'queue') throw Object.assign(new Error(err.message), { status: 503, retryable: true });
    const message = err.limit === 'time' ? 'Reading this PDF took too long, so it was stopped. Try a smaller or re-saved copy.'
      : err.limit === 'memory' ? 'Reading this PDF needed too much memory, so it was stopped. Try a smaller or re-saved copy.'
      : /password/i.test(err.message) ? 'Password-protected PDF; upload an unlocked copy.'
      : 'Could not parse this PDF: ' + String(err.message).slice(0, 200);
    throw Object.assign(new Error(message), { status: 422 });
  }
  // What the text caps still allow OCR to add, as the walk left it.
  let remaining = TOTAL_TEXT_CAP - pageTexts.reduce((n, p) => n + (p.text ? p.text.length : 0), 0);
  let retryable = false, ocrError, ocrErrorId;
  const candidates = pageTexts.filter(p => ['ocr-needed', 'unreadable'].includes(p.status));
  if (ocrEnabled && candidates.length) {
    try {
      const results = await extractPages(bytes, candidates.slice(0, 50).map(p => p.number));
      for (const p of candidates.slice(0, 50)) {
        const result = results.find(r => r.number === p.number);
        if (!result || result.error) { retryable = true; ocrError = result?.error || 'OCR response omitted pages; refresh to retry.'; ocrErrorId = result?.error ? undefined : 'ocrOmittedPages'; continue; }
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
      if (candidates.length > 50) { ocrError = 'OCR limited to 50 image-bearing pages per document.'; ocrErrorId = 'ocrPageLimit'; }
    } catch (err) { retryable = true; ocrError = String(err.message || err).slice(0, 300); ocrErrorId = undefined; }
  }
  const assembled = assemble(pageTexts, numPages, { retryable });
  // errorId (#607) is the stable id of the message when noevia wrote it, so the browser can show it
  // in the interface language; an error that came from the OCR service or a library stays as it is.
  const noText = assembled.state === 'failed' && !ocrError;
  return { ...assembled, error: ocrError || (noText ? (ocrEnabled ? 'No readable text was recovered by OCR; try a clearer scan or an unlocked original.' : 'No readable native text. Scanned or image-based content needs OCR; OCR is not installed.') : undefined),
    ...(ocrError ? (ocrErrorId ? { errorId: ocrErrorId } : {}) : noText ? { errorId: ocrEnabled ? 'noOcrText' : 'noNativeText' } : {}) };
}
// A test may pin the version (multimodal-followups-1770-1772.test.cjs assigns it); production never does.
let versionOverride = null;
module.exports = { isDocument, documentExtensions, extractDocumentText, DOCUMENT_EXTENSIONS, EXTRACT_CAP, get EXTRACTOR_VERSION() { return versionOverride ?? extractorVersion(); }, set EXTRACTOR_VERSION(v) { versionOverride = v; }, PAGE_CAP, TOTAL_TEXT_CAP };
