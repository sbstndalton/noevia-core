'use strict';
const { readCappedJson } = require('./http.cjs');
const workers = require('./document-workers.cjs');
// Only the operator-configured private worker receives bytes, never a model or cloud API.
const OCR_REPLY_CAP = 16 * 1024 * 1024;
const VERSION = 'tesseract5-eng-deu-poppler-3500-v1';
// #1865: `dpi` (400 or 600) renders the pages finer, for the retry of a page the first pass left
// incomplete (X-OCR-DPI; a worker from before it ignores the header and renders at its default 300).
// `timeoutMs` bounds that retry on its own. Without either the request is exactly as before.
// #1882: never 600 (unmeasured in the worker's memory limit): 400 is the only finer render core asks for.
const RETRY_DPIS = new Set([400]);
async function extractPages(bytes, pages, options = {}) {
  // #1841: the machine OCR is assigned to, else OCR_BASE_URL; a machine is reached through the on-this-network fetch.
  const target = workers.resolve('ocr');
  const url = options.url === undefined ? target.url : options.url;
  const fetchImpl = options.fetchImpl || (options.url === undefined ? target.fetch : fetch);
  if (!url) return [];
  const response = await fetchImpl(`${url.replace(/\/+$/, '')}/extract`, {
    method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/pdf', 'X-OCR-Pages': JSON.stringify(pages.slice(0, 50)),
      ...(RETRY_DPIS.has(options.dpi) ? { 'X-OCR-DPI': String(options.dpi) } : {}) },
    body: bytes, signal: AbortSignal.timeout(Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0 ? Math.min(options.timeoutMs, 610000) : 610000),
  });
  if (!response.ok) throw Object.assign(new Error(response.status === 503 ? 'OCR is busy; refresh to retry.' : `OCR unavailable (HTTP ${response.status}); refresh to retry.`), { status: response.status });
  // 50 pages of recognised text per call; 16 MB is far above that (#920).
  const body = await readCappedJson(response, OCR_REPLY_CAP).catch((e) => { throw e?.code === 'too_large' ? new Error('Invalid OCR response; refresh to retry.') : e; });
  if (!Array.isArray(body.pages)) throw new Error('Invalid OCR response; refresh to retry.');
  return body.pages;
}
// #1867: what the worker reads, from its /health: `{ maxBytes, dpis }` when it says `"ranges": true` (it
// renders only the asked pages of a body up to maxBytes, and X-OCR-DPI is one of dpis); `{}` for a worker
// from before that (25 MB, 300 dpi only); null when it could not be asked. A definite answer is kept for a
// minute. A core that never asks keeps sending at most 25 MB, so old and new versions interoperate.
const LEGACY_MAX_BYTES = 25 * 1024 * 1024;
// #1882: positive AND negative answers are kept CAPABILITY_TTL_MS, so a sync against an old or unreachable
// worker does not ask (and re-open size-refused records) every time.
const CAPABILITY_TTL_MS = 5 * 60_000;
let capabilitiesCache = { at: 0, url: null, value: undefined };
async function capabilities(options = {}) {
  const target = workers.resolve('ocr');
  const url = options.url === undefined ? target.url : options.url;
  const fetchImpl = options.fetchImpl || (options.url === undefined ? target.fetch : fetch);
  if (!url) return null;
  const now = Date.now();
  if (!options.fresh && capabilitiesCache.url === url && now - capabilitiesCache.at < CAPABILITY_TTL_MS) return capabilitiesCache.value;
  try {
    const response = await fetchImpl(`${url.replace(/\/+$/, '')}/health`, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if (!response.ok) { capabilitiesCache = { at: now, url, value: null }; return null; }
    const body = await readCappedJson(response, 64 * 1024);
    const value = body?.ranges === true
      ? { ...(Number.isSafeInteger(body.maxBytes) && body.maxBytes > 0 ? { maxBytes: body.maxBytes } : {}),
        ...(Array.isArray(body.dpis) ? { dpis: body.dpis.filter((d) => Number.isSafeInteger(d)) } : {}) }
      : {};
    capabilitiesCache = { at: now, url, value };
    return value;
  } catch { capabilitiesCache = { at: now, url, value: null }; return null; }
}
/** The largest body the worker takes (never below the 25 MB every worker accepts), from `capabilities`. */
const maxBytesOf = (caps) => Math.max(LEGACY_MAX_BYTES, Number.isSafeInteger(caps?.maxBytes) ? caps.maxBytes : 0);
/** Whether the worker really renders at `dpi` (an older one ignores X-OCR-DPI and renders at 300). */
const rendersAt = (caps, dpi) => Array.isArray(caps?.dpis) && caps.dpis.includes(dpi);
module.exports = { CAPABILITY_TTL_MS, extractPages, capabilities, maxBytesOf, rendersAt, LEGACY_MAX_BYTES, VERSION };
