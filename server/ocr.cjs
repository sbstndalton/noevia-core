'use strict';
// Only the operator-configured private worker receives bytes, never a model or cloud API.
const VERSION = 'tesseract5-eng-deu-poppler-3500-v1';
async function extractPages(bytes, pages, { url = process.env.OCR_BASE_URL, fetchImpl = fetch } = {}) {
  if (!url) return [];
  const response = await fetchImpl(`${url.replace(/\/+$/, '')}/extract`, {
    method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/pdf', 'X-OCR-Pages': JSON.stringify(pages.slice(0, 50)) },
    body: bytes, signal: AbortSignal.timeout(610000),
  });
  if (!response.ok) throw new Error(response.status === 503 ? 'OCR is busy; refresh to retry.' : `OCR unavailable (HTTP ${response.status}); refresh to retry.`);
  const body = await response.json();
  if (!Array.isArray(body.pages)) throw new Error('Invalid OCR response; refresh to retry.');
  return body.pages;
}
module.exports = { extractPages, VERSION };
