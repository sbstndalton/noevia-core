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
const sourceLimits = require('./source-limits.cjs');
const largeLock = require('./large-document-lock.cjs');

// #1864: the most one request to a sidecar may carry today (their LIMIT, 25 MiB; services/docling and
// services/ocr, Python and native alike). A larger PDF is read in page ranges from the start: through
// Docling when its /health says it reads ranges (`"ranges": true`), otherwise with the pdf.js reader here,
// a range per worker. A smaller PDF is read exactly as before; only its pages past the first window
// (PAGE_CAP) follow in ranges, the same way. OCR is never sent a body over OCR_MAX_BYTES.
const WHOLE_BYTES = 25 * 1024 * 1024;
const OCR_MAX_BYTES = 25 * 1024 * 1024;
const OCR_TOO_LARGE = 'This PDF is larger than the OCR service accepts (25 MB), so its image-bearing pages were not sent to OCR; their own text layer was read.';
// #1864/#1865: the pass that reads the pages past the first window and retries incomplete pages with OCR.
// It runs once per stored result: a result carries this marker once it has run, whatever came of it, so
// it is never repeated for the same bytes and extractor version. A result stored before this existed has
// no marker and gets the pass the next time its source is read (a targeted re-read of only the documents
// it can change: EXTRACTOR_VERSION, and with it every stored result, is untouched).
const COMPLETION = 'ranges-ocr-retry-v1';
// #1865: a page left in one of these states after the first pass is retried alone through the local OCR
// worker, finer than the first pass. 'blank' is not: Docling cannot tell an empty page from an unread one,
// and OCRing every blank page of every document is not a bounded retry. 'truncated' hit a cap, not a gap.
// 'ocr-needed' is an image-bearing page the first pass could not send to OCR (over its page cap, or the
// file too large for the worker): it is retried the same way, and says so when it cannot be.
const RETRY_STATUSES = new Set(['degraded', 'failed', 'unreadable', 'ocr-needed']);
const RETRY_PAGE_CAP = 20;     // pages retried per document; the rest say so
const RETRY_BATCH = 10;        // pages per OCR request
const RETRY_DPI = 400;         // the first pass renders at 300 dpi
const RETRY_TIMEOUT_MS = 300_000; // per OCR request; the whole pass is at most two of them
const BUSY_WAITS_MS = [5_000, 15_000]; // a busy worker (one slot) is asked again this often, then given up
// A retry that failed for a passing reason (the worker busy, unreachable, too old for the request) is
// tried again on a later read, up to this many attempts per page in all. Any other outcome is final.
const RETRY_ATTEMPTS = 3;
const COMPLETE_STATUSES = ['native', 'blank', 'ocr'];

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
// Pages are numbered from 1 without gaps, so a document with more pages than were read is incomplete
// (before #1864 that was "more than PAGE_CAP pages", which is the same thing for a one-window read).
function assemble(pageTexts, totalPages, { retryable = false, error, extraTruncated = false, stoppedAt } = {}) {
  const full = pageTexts.map(p => `[Page ${p.number}]\n${p.text || '(' + p.status + ')'}`).join('\n\n');
  const readable = pageTexts.some(p => p.text);
  const missing = totalPages > pageTexts.length;
  const incomplete = pageTexts.some(p => !COMPLETE_STATUSES.includes(p.status)) || missing;
  const truncated = full.length > EXTRACT_CAP || pageTexts.some(p => p.truncated) || missing || extraTruncated;
  const state = !readable && incomplete ? 'failed' : incomplete || truncated ? 'partial' : 'ready';
  return { text: readable ? full.slice(0, EXTRACT_CAP) : '', pages: totalPages, pageTexts, truncated, state, retryable, error,
    ...(stoppedAt ? { stoppedAt } : {}) };
}

/** A Docling reply's pages in the shared page shape. */
function doclingPages(body, figures) {
  // A 'degraded' page (#700) is one Docling left (near-)empty whose text came from the PDF's own
  // text layer instead. It is readable — its text is in `full` and reaches retrieval — but it is
  // not in the complete set, so the document is 'partial', never plain ready.
  return body.pages.map(p => ({
    number: Number(p.number), text: String(p.text || ''), status: String(p.status || 'failed'),
    method: p.method === 'pdfium' ? 'pdfium' : 'docling', truncated: !!p.truncated,
    ...(typeof p.reason === 'string' && /^[a-z-]{1,40}$/.test(p.reason) ? { reason: p.reason } : {}),
    // #1726: the worker's scanned-page marker (sent only when figures were asked for).
    ...(figures && p.ocr === true ? { ocr: true } : {}),
  }));
}

async function extractWithDocling(name, bytes, extractDocument, figures = false, rangePages = sourceLimits.documentLimits().rangePages) {
  // #1864: a PDF larger than one whole-document request is read from its first range (the caller has
  // checked that the worker reads ranges); the rest follows in completeDocument. Anything else is one
  // request, exactly as before.
  const ranged = bytes.length > WHOLE_BYTES && /\.pdf$/i.test(String(name || ''));
  const options = { ...(figures ? { figures: true } : {}), ...(ranged ? { pages: [1, rangePages] } : {}) };
  let body;
  try {
    body = Object.keys(options).length ? await extractDocument(name, bytes, options) : await extractDocument(name, bytes);
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
  const pageTexts = doclingPages(body, figures);
  const total = Number(body.total) || pageTexts.length;
  const out = assemble(pageTexts, total, { extraTruncated: !ranged && !!body.truncatedPages });
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

/** OCR for the native pass's image-bearing pages, merged into `pages` in place. At most `cap` pages are
 *  sent; `remaining` is what the text caps still allow. Returns what happened, for the document's error. */
async function ocrNativePages(bytes, candidates, { extractPages, remaining, cap }) {
  let retryable = false, ocrError, ocrErrorId;
  // #1864: never sent a body the worker refuses; final, not retryable (the bytes will not shrink).
  if (bytes.length > OCR_MAX_BYTES) return { retryable: false, ocrError: OCR_TOO_LARGE, ocrErrorId: 'ocrTooLarge', remaining, sent: 0 };
  const chosen = candidates.slice(0, Math.max(0, cap));
  if (chosen.length) {
    try {
      for (const p of chosen) p.ocrSent = true; // #1871: not retried at the same resolution (see retry)
      const results = await extractPages(bytes, chosen.map(p => p.number));
      for (const p of chosen) {
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
    } catch (err) { retryable = true; ocrError = String(err.message || err).slice(0, 300); ocrErrorId = undefined; }
  }
  if (candidates.length > chosen.length) { ocrError = 'OCR limited to 50 image-bearing pages per document.'; ocrErrorId = 'ocrPageLimit'; }
  return { retryable, ocrError, ocrErrorId, remaining, sent: chosen.length };
}

const textLength = (pages) => pages.reduce((n, p) => n + (p.text ? p.text.length : 0), 0);

// Preserve native text and add separately labelled OCR for image-bearing pages.
async function extractDocumentText(name, bytes, {
  ocrEnabled = workers.configured('ocr'),
  extractPages = ocr.extractPages,
  doclingEnabled = docling.enabled(),
  extractDocument = docling.extractDocument,
  readPages = native.readInWorker,
  figures = figuresOn(),
  env = process.env,
  rangesSupported = docling.rangesSupported,
  waits = BUSY_WAITS_MS,
  ocrBudget,
} = {}) {
  if (!isDocument(name, doclingEnabled)) {
    throw Object.assign(new Error(`not a supported document (${documentExtensions(doclingEnabled).join(', ')})`), { status: 400 });
  }
  const deps = { ocrEnabled, extractPages, doclingEnabled, extractDocument, readPages, figures, env, rangesSupported, waits, ocrBudget };
  // #1871: a large document is read under the process-wide lock (a no-op when the caller already holds it).
  return largeLock.ifLarge(bytes.length, () => extractUnlocked(name, bytes, deps), () => byteRef(bytes));
}

async function extractUnlocked(name, bytes, deps) {
  const { ocrEnabled, extractPages, doclingEnabled, extractDocument, readPages, figures, env, rangesSupported } = deps;
  const limits = sourceLimits.documentLimits(env);
  // #1864: a PDF too large for one Docling request goes to Docling only if it reads page ranges; otherwise
  // it is read here, range by range, rather than refused.
  const large = bytes.length > WHOLE_BYTES && /\.pdf$/i.test(String(name || ''));
  if (doclingEnabled && (!large || await rangesSupported() === true)) {
    return completeDocument(name, bytes, await extractWithDocling(name, bytes, extractDocument, figures, limits.rangePages), deps);
  }
  // pdf.js runs in a worker with a time and a heap limit (documents-native.cjs): a pathological
  // PDF stops itself, not the server. A limit is as final as an unreadable file.
  // #1864: a PDF larger than WHOLE_BYTES reads its first range here (each range is its own worker, with
  // its own limits); a smaller one reads the first PAGE_CAP pages in one worker, exactly as before.
  const firstWindow = bytes.length > WHOLE_BYTES ? limits.rangePages : PAGE_CAP;
  let numPages, pageTexts;
  try {
    ({ numPages, pageTexts } = await readPages(readerBytes(bytes), { pageCap: firstWindow, pageTextCap: PAGE_TEXT_CAP, totalTextCap: TOTAL_TEXT_CAP }));
  } catch (err) {
    if (err.limit === 'queue') throw Object.assign(new Error(err.message), { status: 503, retryable: true });
    throw Object.assign(new Error(nativeFailure(err)), { status: 422 });
  }
  // What the text caps still allow OCR to add, as the walk left it.
  const candidates = pageTexts.filter(p => ['ocr-needed', 'unreadable'].includes(p.status));
  const ocrResult = ocrEnabled && candidates.length
    ? await ocrNativePages(bytes, candidates, { extractPages, remaining: TOTAL_TEXT_CAP - textLength(pageTexts), cap: 50 })
    : { retryable: false, sent: 0 };
  // An image-bearing page of a PDF too large for the OCR worker stays 'ocr-needed', and the document says why.
  const { retryable, ocrError, ocrErrorId } = ocrResult;
  const assembled = assemble(pageTexts, numPages, { retryable });
  // errorId (#607) is the stable id of the message when noevia wrote it, so the browser can show it
  // in the interface language; an error that came from the OCR service or a library stays as it is.
  const noText = assembled.state === 'failed' && !ocrError;
  const out = { ...assembled, error: ocrError || (noText ? (ocrEnabled ? 'No readable text was recovered by OCR; try a clearer scan or an unlocked original.' : 'No readable native text. Scanned or image-based content needs OCR; OCR is not installed.') : undefined),
    ...(ocrError ? (ocrErrorId ? { errorId: ocrErrorId } : {}) : noText ? { errorId: ocrEnabled ? 'noOcrText' : 'noNativeText' } : {}),
    ...(ocrResult.sent ? { ocrPagesSent: ocrResult.sent } : {}) };
  return completeDocument(name, bytes, out, deps);
}

// #1871: the range workers of a large PDF read one shared-memory copy of it instead of a copy each; a
// buffer read from storage is already there (storage-client.cjs), so this copies nothing then.
const readerBytes = (bytes) => (bytes.length > WHOLE_BYTES ? native.sharedBytes(bytes) : bytes);

/** #1871: OCR pages one source sync may spend on retries, across all its documents. */
function ocrBudget(env = process.env) { return { remaining: sourceLimits.documentLimits(env).syncOcrPages }; }

function nativeFailure(err) {
  return err.limit === 'time' ? 'Reading this PDF took too long, so it was stopped. Try a smaller or re-saved copy.'
    : err.limit === 'memory' ? 'Reading this PDF needed too much memory, so it was stopped. Try a smaller or re-saved copy.'
    : /password/i.test(err.message) ? 'Password-protected PDF; upload an unlocked copy.'
    : 'Could not parse this PDF: ' + String(err.message).slice(0, 200);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isBusy = (err) => err?.status === 503 || err?.limit === 'queue';
// A failure that says the worker is busy, away or older than the request, not that the page is bad. A
// timeout is NOT one: the same page would time out again (document-sources.cjs serviceDown, #1770).
const isPassing = (err) => isBusy(err) || err?.status === 400
  || /busy|unavailable|not configured|fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH/i.test(String(err?.message || ''));
/** A page whose retry failed for a passing reason and may be tried again on a later read. */
const retryDue = (p) => RETRY_STATUSES.has(p.status) && p.retry?.outcome === 'failed' && p.retry.again === true;
/** `fn`, asked again while the worker answers busy (it has one slot), BUSY_WAITS_MS apart; then the error. */
async function patiently(fn, waits = BUSY_WAITS_MS) {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); }
    catch (err) { if (!isBusy(err) || attempt >= waits.length) throw err; await wait(waits[attempt]); }
  }
}

/**
 * #1864/#1865: finish a first-pass result. Reads the pages past the first window in ranges, up to the page
 * and text ceilings (source-limits.cjs documentLimits), then retries each page left incomplete through
 * the local OCR worker. Runs once per result (COMPLETION); the result says where it stopped and why
 * (`stoppedAt`) and what each retried page came to (`pageTexts[].retry`).
 *
 * A result that is itself a transient failure (`retryable`) is left alone: it is read again whole anyway.
 */
async function completeDocument(name, bytes, out, deps = {}) {
  if (!out || out.completion === COMPLETION || out.retryable || !Array.isArray(out.pageTexts) || !out.pageTexts.length) return out;
  if (!/\.pdf$/i.test(String(name || ''))) return { ...out, completion: COMPLETION };
  return largeLock.ifLarge(bytes.length, () => completeUnlocked(name, bytes, out, deps), () => byteRef(bytes));
}

async function completeUnlocked(name, bytes, out, deps) {
  const {
    ocrEnabled = workers.configured('ocr'), extractPages = ocr.extractPages, doclingEnabled = docling.enabled(),
    extractDocument = docling.extractDocument, readPages = native.readInWorker, figures = figuresOn(), env = process.env,
    waits = BUSY_WAITS_MS, rangesSupported = docling.rangesSupported, ocrBudget,
  } = deps;
  const limits = sourceLimits.documentLimits(env);
  // #1871: in page order, and a page missing below the highest one read is a failed page, so reading
  // resumes after the highest page and never re-reads or skips one.
  const pageTexts = out.pageTexts.map((p) => ({ ...p })).sort((a, b) => a.number - b.number);
  const highest = pageTexts.length ? pageTexts[pageTexts.length - 1].number : 0;
  for (let n = 1, i = 0; n <= highest; n++) {
    if (pageTexts[i]?.number === n) { i++; continue; }
    pageTexts.splice(i, 0, { number: n, text: '', status: 'failed', method: pageTexts[0]?.method === 'native' ? 'native' : 'docling' });
    i++;
  }
  const total = Number(out.pages) || pageTexts.length;
  let stoppedAt, foundFigures = Array.isArray(out.figures) ? out.figures.slice() : undefined;
  // A stop for a passing reason leaves the marker off, so a later read resumes where this one stopped.
  let passing = false;
  let ocrSent = Number(out.ocrPagesSent) || 0, ocrError, ocrErrorId, rangeAttempts;

  // 1. #1864: the pages past what the first pass read, a range at a time.
  const last = Math.min(total, limits.pages);
  let next = pageTexts.length + 1, used = textLength(pageTexts); // = the highest page read + 1 (gaps filled above)
  // Docling reads the ranges when its worker says it can; otherwise (and for a document read here in the
  // first place) the pdf.js reader does, a range per worker. Per page, `method` says which.
  let viaDocling = doclingEnabled && next <= last && pageTexts.some((p) => p.method !== 'native' && p.method !== 'native+ocr')
    && await rangesSupported() === true;
  while (next <= last) {
    if (used >= limits.text) { stoppedAt = { page: next - 1, limit: 'text' }; break; }
    const end = Math.min(last, next + limits.rangePages - 1);
    const budget = limits.text - used;
    let got;
    try {
      if (viaDocling) {
        const body = await patiently(() => extractDocument(name, bytes, { pages: [next, end], ...(figures ? { figures: true } : {}) }), waits);
        got = doclingPages(body, figures);
        if (figures) {
          const offset = (foundFigures || []).reduce((n, f) => Math.max(n, Number(f.index) + 1), 0);
          const room = 64 - (foundFigures || []).length;
          const extra = parseFigures(body.figures, got).slice(0, Math.max(0, room)).map((f) => ({ ...f, index: offset + f.index }));
          if (extra.length) foundFigures = [...(foundFigures || []), ...extra];
        }
      } else {
        const read = await patiently(() => readPages(readerBytes(bytes), { firstPage: next, pageCap: end - next + 1, pageTextCap: PAGE_TEXT_CAP, totalTextCap: Math.min(TOTAL_TEXT_CAP, budget) }), waits);
        got = read.pageTexts;
        const candidates = got.filter(p => ['ocr-needed', 'unreadable'].includes(p.status));
        if (ocrEnabled && candidates.length) {
          const r = await ocrNativePages(bytes, candidates, { extractPages, remaining: budget - textLength(got), cap: 50 - ocrSent });
          ocrSent += r.sent;
          if (r.ocrError) { ocrError = r.ocrError; ocrErrorId = r.ocrErrorId; }
        }
      }
    } catch (err) {
      // A worker that said it reads ranges but did not: the rest is read here instead.
      if (viaDocling && err?.code === 'no-ranges') { viaDocling = false; continue; }
      stoppedAt = { page: next - 1, limit: 'error', error: String(err?.limit ? nativeFailure(err) : err?.message || err).slice(0, 200) };
      // #1871: a passing stop (busy, unreachable) is resumed on later reads, at most RETRY_ATTEMPTS in all;
      // then the stop is stored as final.
      rangeAttempts = (Number(out.rangeAttempts) || 0) + 1;
      passing = isPassing(err) && rangeAttempts < RETRY_ATTEMPTS;
      break;
    }
    // Only this range's pages, in order and without gaps: a page the reply left out is a failed page.
    const byNumber = new Map(got.filter((p) => p.number >= next && p.number <= end).map((p) => [p.number, p]));
    for (let n = next; n <= end; n++) {
      const page = byNumber.get(n) || { number: n, text: '', status: 'failed', method: viaDocling ? 'docling' : 'native' };
      const room = limits.text - used;
      if (page.text && page.text.length > room) { page.text = page.text.slice(0, Math.max(0, room)); page.truncated = true; page.status = 'truncated'; }
      used += page.text ? page.text.length : 0;
      pageTexts.push(page);
    }
    next = end + 1;
  }
  if (!stoppedAt && pageTexts.length < total) stoppedAt = { page: pageTexts.length, limit: 'pages' };

  // 2. #1865: each page still incomplete, alone, through the local OCR worker, finer than the first pass.
  const retried = await retryIncompletePages(bytes, pageTexts, { ocrEnabled, extractPages, room: limits.text - textLength(pageTexts), waits, ocrBudget });
  if (pageTexts.some(retryDue) || retried.deferred) passing = true;

  const assembled = assemble(pageTexts, total, { retryable: false, stoppedAt });
  // An error that said "no text at all" is no longer true once a retry found some.
  const staleNoText = assembled.state !== 'failed' && ['noOcrText', 'noNativeText'].includes(out.errorId);
  const error = ocrError || (staleNoText ? undefined : out.error);
  const errorId = ocrError ? ocrErrorId : staleNoText ? undefined : out.errorId;
  const { ocrPagesSent: _sent, stoppedAt: _old, ...rest } = out;
  return { ...rest, ...assembled, error, ...(errorId ? { errorId } : { errorId: undefined }), completion: passing ? undefined : COMPLETION,
    ...(rangeAttempts ? { rangeAttempts } : {}),
    ...(foundFigures && foundFigures.length ? { figures: foundFigures } : {}) };
}

// #1878: pages the OCR budget pushed to the next sync. One content-free line per document (counts only,
// plus the running totals of the sync whose budget it is); cumulative counts for a release watch.
// The document's identity for a log line: its content hash, taken only if a line is written, never its name.
const byteRef = (bytes) => require('node:crypto').createHash('sha256').update(bytes).digest('hex');
const ocrDeferrals = { pages: 0, documents: 0 };
function noteOcrDeferral(budget, pages) {
  ocrDeferrals.pages += pages; ocrDeferrals.documents += 1;
  let sync = '';
  if (budget && typeof budget === 'object') {
    budget.deferredPages = (Number(budget.deferredPages) || 0) + pages;
    budget.deferredDocuments = (Number(budget.deferredDocuments) || 0) + 1;
    sync = ` syncPagesDeferred=${budget.deferredPages} syncDocumentsDeferred=${budget.deferredDocuments}`;
  }
  console.log(`[documents] OCR budget deferred pages to the next sync: pagesDeferred=${pages} documentsDeferred=1${sync}`);
}

/** #1865: retry `pages` left incomplete, at most RETRY_PAGE_CAP of them, in place. Each gets `retry`:
 *  recovered (its OCR text is merged and the page counts as read), empty, failed (with the reason),
 *  unavailable (no OCR worker is configured) or skipped (over the page cap). Never repeated: a page that
 *  already has `retry` is left alone. */
// #1871: a page the first pass already sent to the OCR worker is not retried: today's workers ignore
// X-OCR-DPI, so it would be the same 300 dpi pass again (until #1867). That is a page marked `ocrSent`, or,
// in a result stored before the mark existed, an 'unreadable' page of the pdf.js pass while OCR is on (that
// pass sends every unreadable page to OCR).
const alreadyOcred = (p, ocrEnabled) => p.ocrSent === true || (ocrEnabled && p.status === 'unreadable' && p.method === 'native');

async function retryIncompletePages(bytes, pages, { ocrEnabled, extractPages, room, waits = BUSY_WAITS_MS, ocrBudget }) {
  const candidates = pages.filter((p) => RETRY_STATUSES.has(p.status) && (!p.retry || retryDue(p)) && !alreadyOcred(p, ocrEnabled));
  if (!candidates.length) return { deferred: false };
  if (!ocrEnabled) { for (const p of candidates) p.retry = { outcome: 'unavailable' }; return { deferred: false }; }
  if (bytes.length > OCR_MAX_BYTES) {
    for (const p of candidates) p.retry = { outcome: 'failed', error: 'the PDF is larger than the OCR service accepts (25 MB)' };
    return { deferred: false };
  }
  // Pages already tried once count against the cap too, so the cap holds across reads.
  const tried = pages.filter((p) => p.retry && p.retry.outcome !== 'skipped' && p.retry.outcome !== 'unavailable' && !candidates.includes(p)).length;
  const capped = candidates.slice(0, Math.max(0, RETRY_PAGE_CAP - tried));
  for (const p of candidates.slice(capped.length)) p.retry = { outcome: 'skipped' };
  // #1871: and within what this sync may still spend on OCR (all its documents together). Pages past it are
  // left as they are, and the document stays open (no completion marker), so a later sync goes on.
  const allowed = ocrBudget ? Math.max(0, Math.min(capped.length, Number(ocrBudget.remaining) || 0)) : capped.length;
  const chosen = capped.slice(0, allowed);
  if (ocrBudget) ocrBudget.remaining = Math.max(0, (Number(ocrBudget.remaining) || 0) - chosen.length);
  const deferred = chosen.length < capped.length;
  if (deferred) noteOcrDeferral(ocrBudget, capped.length - chosen.length);
  for (let i = 0; i < chosen.length; i += RETRY_BATCH) {
    const batch = chosen.slice(i, i + RETRY_BATCH);
    let results;
    try {
      results = await patiently(() => extractPages(bytes, batch.map((p) => p.number), { dpi: RETRY_DPI, timeoutMs: RETRY_TIMEOUT_MS }), waits);
      if (!Array.isArray(results)) throw new Error('Invalid OCR response.');
    } catch (err) {
      const reason = /timeout|aborted/i.test(String(err?.name || '') + String(err?.message || '')) ? 'OCR took too long' : String(err?.message || err).slice(0, 200);
      const passingFailure = isPassing(err);
      for (const p of batch) {
        const attempts = (Number(p.retry?.attempts) || 0) + 1;
        p.retry = { outcome: 'failed', dpi: RETRY_DPI, error: reason, attempts, ...(passingFailure && attempts < RETRY_ATTEMPTS ? { again: true } : {}) };
      }
      continue;
    }
    for (const p of batch) {
      const result = results.find((r) => r && r.number === p.number);
      if (!result || result.error) { p.retry = { outcome: 'failed', dpi: RETRY_DPI, error: String(result?.error || 'OCR returned nothing for this page').slice(0, 200) }; continue; }
      const text = typeof result.text === 'string' ? result.text.trim() : '';
      if (!text) { p.retry = { outcome: 'empty', dpi: RETRY_DPI }; continue; }
      const addition = `${p.text ? '\n' : ''}[OCR transcription — verify numbers against original]\n${text}`;
      const available = Math.max(0, Math.min(PAGE_TEXT_CAP - (p.text || '').length, room));
      if (!available) { p.retry = { outcome: 'failed', dpi: RETRY_DPI, error: 'text limit reached' }; continue; }
      const from = p.status;
      p.text = (p.text || '') + addition.slice(0, available);
      room -= Math.min(addition.length, available);
      p.truncated = !!result.truncated || addition.length > available;
      p.status = p.truncated ? 'truncated' : 'ocr';
      p.method = `${p.method || 'native'}+ocr`;
      delete p.reason;
      p.retry = { outcome: 'recovered', dpi: RETRY_DPI, from };
    }
  }
  return { deferred };
}

// A test may pin the version (multimodal-followups-1770-1772.test.cjs assigns it); production never does.
let versionOverride = null;
module.exports = { ocrDeferrals, isDocument, documentExtensions, extractDocumentText, completeDocument, ocrBudget, COMPLETION, WHOLE_BYTES, RETRY_PAGE_CAP, RETRY_DPI, RETRY_ATTEMPTS, OCR_MAX_BYTES, DOCUMENT_EXTENSIONS, EXTRACT_CAP, get EXTRACTOR_VERSION() { return versionOverride ?? extractorVersion(); }, set EXTRACTOR_VERSION(v) { versionOverride = v; }, PAGE_CAP, TOTAL_TEXT_CAP };
