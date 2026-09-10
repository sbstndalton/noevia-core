'use strict';

const EXTRACT_CAP = 200_000; // compact project/RAG text, not the page store
const PAGE_TEXT_CAP = 200_000;
const TOTAL_TEXT_CAP = 2_000_000;
const PAGE_CAP = 300;
const EXTRACTOR_VERSION = 'native-pages-v1';
const DOCUMENT_EXTENSIONS = new Set(['.pdf']);
function isDocument(name) { return /\.pdf$/i.test(String(name || '')); }

// Native text only. Image-bearing pages are conservatively partial: an image
// may contain text even when the page also has a digital header. No OCR claim.
async function extractDocumentText(name, bytes) {
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
    const full = pageTexts.map(p => `[Page ${p.number}]\n${p.text || '(' + p.status + ')'}`).join('\n\n');
    const readable = pageTexts.some(p => p.text);
    const incomplete = pageTexts.some(p => !['native', 'blank'].includes(p.status)) || pdf.numPages > PAGE_CAP;
    const truncated = full.length > EXTRACT_CAP || pageTexts.some(p => p.truncated) || pdf.numPages > PAGE_CAP;
    const state = !readable && incomplete ? 'failed' : incomplete || truncated ? 'partial' : 'ready';
    return { text: readable ? full.slice(0, EXTRACT_CAP) : '', pages: pdf.numPages, pageTexts,
      truncated, state, error: state === 'failed' ? 'No readable native text. Scanned or image-based content needs OCR; OCR is not installed.' : undefined };
  } catch (err) {
    throw Object.assign(new Error(/password/i.test(err.message) ? 'Password-protected PDF; upload an unlocked copy.' : 'Could not parse this PDF: ' + String(err.message).slice(0, 200)), { status: 422 });
  } finally { if (pdf) await pdf.loadingTask.destroy(); }
}
module.exports = { isDocument, extractDocumentText, DOCUMENT_EXTENSIONS, EXTRACT_CAP, EXTRACTOR_VERSION, PAGE_CAP, TOTAL_TEXT_CAP };
