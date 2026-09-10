'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { extractDocumentText } = require('./documents.cjs');
const { extractPages } = require('./ocr.cjs');
const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures/documents', name));

test('OCR handles scans and mixed pages without discarding native text', async () => {
  for (const name of ['scanned.pdf', 'mixed-page.pdf', 'mixed-pages.pdf']) {
    const seen = [];
    const out = await extractDocumentText(name, fixture(name), { ocrEnabled: true, extractPages: async (bytes, pages) => {
      assert.deepEqual(bytes, fixture(name)); seen.push(...pages);
      return pages.map(number => ({ number, text: 'INV-2042 Refund -7.20 TOTAL 34.95' }));
    } });
    assert.equal(out.state, 'ready');
    assert.match(out.text, /OCR transcription.*verify numbers/);
    assert.match(out.text, /TOTAL 34.95/);
    assert.equal(seen.length, 1);
    if (name === 'mixed-pages.pdf') assert.match(out.pageTexts[0].text, /TEXT-P1/);
    if (name === 'mixed-page.pdf') assert.match(out.text, /DIGITAL HEADER/);
  }
});

test('native PDFs do not call OCR and blank OCR is never called ready', async () => {
  const native = await extractDocumentText('text.pdf', fixture('text.pdf'), { ocrEnabled: true, extractPages: () => { throw new Error('must not run'); } });
  assert.equal(native.state, 'ready');
  const blank = await extractDocumentText('scanned.pdf', fixture('scanned.pdf'), { ocrEnabled: true, extractPages: async () => [{ number: 1, text: '' }] });
  assert.equal(blank.state, 'failed');
});

test('worker failures preserve native text, remain incomplete and are retryable', async () => {
  for (const extract of [async () => { throw new Error('OCR is busy'); }, async () => [], async () => [{ number: 1, error: 'timeout' }]]) {
    const out = await extractDocumentText('mixed-page.pdf', fixture('mixed-page.pdf'), { ocrEnabled: true, extractPages: extract });
    assert.equal(out.state, 'partial'); assert.equal(out.retryable, true); assert.match(out.text, /DIGITAL HEADER/);
  }
});

test('OCR transport sends binary bytes and page selection only to configured worker; errors remain retryable', async () => {
  const bytes = fixture('scanned.pdf');
  await extractPages(bytes, [2], { url: 'http://worker.invalid', fetchImpl: async (url, opts) => {
    assert.equal(url, 'http://worker.invalid/extract'); assert.equal(opts.redirect, 'error');
    assert.deepEqual(opts.body, bytes); assert.equal(opts.headers['X-OCR-Pages'], '[2]');
    return new Response(JSON.stringify({ pages: [{ number: 2, text: 'synthetic' }] }));
  } });
  await assert.rejects(extractPages(bytes, [1], { url: 'http://worker.invalid', fetchImpl: async () => new Response('', { status: 503 }) }), /busy.*retry/);
});

test('retryable worker results are retried on refresh, while successful OCR survives restart-style reads', async () => {
  const os = require('node:os');
  const documents = require('./documents.cjs');
  const sources = require('./document-sources.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-ocr-retry-'));
  const original = documents.extractDocumentText;
  let calls = 0;
  documents.extractDocumentText = async () => {
    calls++;
    return calls === 1
      ? { text: '', pages: 1, pageTexts: [], state: 'failed', retryable: true, error: 'busy' }
      : { text: '[Page 1]\nOCR synthetic total 34.95', pages: 1, pageTexts: [{ number: 1, status: 'ocr', text: 'OCR synthetic total 34.95' }], state: 'ready' };
  };
  try {
    const workspace = { dir };
    const failed = await sources.ingest(workspace, 'p', 'scan.pdf', fixture('scanned.pdf'));
    assert.equal(failed.document.state, 'failed');
    const ready = await sources.ingest(workspace, 'p', 'scan.pdf', fixture('scanned.pdf'), failed);
    assert.equal(ready.document.state, 'ready');
    await sources.ingest({ dir }, 'p', 'scan.pdf', fixture('scanned.pdf'), ready);
    assert.equal(calls, 2);
    assert.match(sources.readPages(workspace, 'p', ready).text, /34.95/);
  } finally { documents.extractDocumentText = original; fs.rmSync(dir, { recursive: true, force: true }); }
});
