'use strict';
const { readCappedJson } = require('./http.cjs');
// Only the operator-configured private worker receives bytes, never a model or cloud API.
const OCR_REPLY_CAP = 16 * 1024 * 1024;
const VERSION = 'tesseract5-eng-deu-poppler-3500-v1';
async function extractPages(bytes, pages, { url = process.env.OCR_BASE_URL, fetchImpl = fetch } = {}) {
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
