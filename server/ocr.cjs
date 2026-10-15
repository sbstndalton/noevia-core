'use strict';
const { readCappedJson } = require('./http.cjs');
const workers = require('./document-workers.cjs');
// Only the operator-configured private worker receives bytes, never a model or cloud API.
const OCR_REPLY_CAP = 16 * 1024 * 1024;
const VERSION = 'tesseract5-eng-deu-poppler-3500-v1';
async function extractPages(bytes, pages, options = {}) {
  // #1841: the machine OCR is assigned to, else OCR_BASE_URL; a machine is reached through the on-this-network fetch.
  const target = workers.resolve('ocr');
  const url = options.url === undefined ? target.url : options.url;
  const fetchImpl = options.fetchImpl || (options.url === undefined ? target.fetch : fetch);
  if (!url) return [];
  const response = await fetchImpl(`${url.replace(/\/+$/, '')}/extract`, {
    method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/pdf', 'X-OCR-Pages': JSON.stringify(pages.slice(0, 50)) },
    body: bytes, signal: AbortSignal.timeout(610000),
  });
  if (!response.ok) throw new Error(response.status === 503 ? 'OCR is busy; refresh to retry.' : `OCR unavailable (HTTP ${response.status}); refresh to retry.`);
  // 50 pages of recognised text per call; 16 MB is far above that (#920).
  const body = await readCappedJson(response, OCR_REPLY_CAP).catch((e) => { throw e?.code === 'too_large' ? new Error('Invalid OCR response; refresh to retry.') : e; });
  if (!Array.isArray(body.pages)) throw new Error('Invalid OCR response; refresh to retry.');
  return body.pages;
}
module.exports = { extractPages, VERSION };
