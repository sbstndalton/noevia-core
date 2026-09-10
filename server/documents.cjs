'use strict';

const EXTRACT_CAP = 200_000; // compact project/RAG text, not the page store
const PAGE_TEXT_CAP = 200_000;
const TOTAL_TEXT_CAP = 2_000_000;
const PAGE_CAP = 300;
const ocr = require('./ocr.cjs');
const EXTRACTOR_VERSION = 'native-pages-v2' + (process.env.OCR_BASE_URL ? ':' + ocr.VERSION : '');
const DOCUMENT_EXTENSIONS = new Set(['.pdf']);
function isDocument(name) { return /\.pdf$/i.test(String(name || '')); }

// Preserve native text and add separately labelled OCR for image-bearing pages.
async function extractDocumentText(name, bytes, { ocrEnabled = !!process.env.OCR_BASE_URL, extractPages = ocr.extractPages } = {}) {
  if (!isDocument(name)) throw Object.assign(new Error('not a supported document (PDF)'), { status: 400 });
  const { getDocumentProxy, getResolvedPDFJS } = require('unpdf');
  let pdf;
  try {
    pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { OPS } = await getResolvedPDFJS();
    const imageOps = new Set(Object.entries(OPS).filter(([name]) => /paint.*Image|paintImageMask/.test(name)).map(([, value]) => value));
    const pageTexts = [];
    let remaining = TOTAL_TEXT_CAP;
    for (let number = 1; number <= Math.min(pdf.numPages, PAGE_CAP); number++) {
      const page = await pdf.getPage(number);
      try {
        const content = await page.getTextContent();
        let text = '', positions = [];
        for (const item of content.items) {
          if (typeof item.str !== 'string') continue;
          // Keep native item order and coordinates for later layout work; do
          // not invent table cells from spacing or reorder financial values.
          const available = Math.min(PAGE_TEXT_CAP, remaining) - text.length;
          if (available <= 0) break;
          text += (item.str + (item.hasEOL ? '\n' : ' ')).slice(0, available);
          positions.push({ text: item.str.slice(0, available), x: item.transform?.[4], y: item.transform?.[5] });
        }
        const truncated = content.items.reduce((n, i) => n + (typeof i.str === 'string' ? i.str.length + 1 : 0), 0) > text.length;
        text = text.trim(); remaining -= text.length;
        const ops = await page.getOperatorList();
        const hasImages = ops.fnArray.some(op => imageOps.has(op));
        const markOps = new Set(Object.entries(OPS).filter(([name]) => /^(stroke|fill|eoFill|shadingFill|paint)/.test(name)).map(([, value]) => value));
        const status = truncated ? 'truncated' : hasImages ? 'ocr-needed' : text ? 'native' : ops.fnArray.some(op => markOps.has(op)) ? 'unreadable' : 'blank';
        pageTexts.push({ number, text, positions, status, hasImages, method: 'native', truncated });
      } catch (err) {
        pageTexts.push({ number, text: '', status: 'failed', method: 'native', error: String(err.message || err).slice(0, 300) });
      } finally { page.cleanup(); }
    }
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
    const full = pageTexts.map(p => `[Page ${p.number}]\n${p.text || '(' + p.status + ')'}`).join('\n\n');
    const readable = pageTexts.some(p => p.text);
    const incomplete = pageTexts.some(p => !['native', 'blank', 'ocr'].includes(p.status)) || pdf.numPages > PAGE_CAP;
    const truncated = full.length > EXTRACT_CAP || pageTexts.some(p => p.truncated) || pdf.numPages > PAGE_CAP;
    const state = !readable && incomplete ? 'failed' : incomplete || truncated ? 'partial' : 'ready';
    return { text: readable ? full.slice(0, EXTRACT_CAP) : '', pages: pdf.numPages, pageTexts,
      truncated, state, retryable, error: ocrError || (state === 'failed' ? (ocrEnabled ? 'No readable text was recovered by OCR; try a clearer scan or an unlocked original.' : 'No readable native text. Scanned or image-based content needs OCR; OCR is not installed.') : undefined) };
  } catch (err) {
    throw Object.assign(new Error(/password/i.test(err.message) ? 'Password-protected PDF; upload an unlocked copy.' : 'Could not parse this PDF: ' + String(err.message).slice(0, 200)), { status: 422 });
  } finally { if (pdf) await pdf.loadingTask.destroy(); }
}
module.exports = { isDocument, extractDocumentText, DOCUMENT_EXTENSIONS, EXTRACT_CAP, EXTRACTOR_VERSION, PAGE_CAP, TOTAL_TEXT_CAP };
