'use strict';
// sbstndalton/noevia#1867: OCR for PDFs over 25 MiB and real higher-DPI retries, as soon as the OCR
// worker's /health says it can (`"ranges": true, "maxBytes", "dpis"`). Synthetic PDFs only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const documents = require('./documents.cjs');
const documentSources = require('./document-sources.cjs');
const ocr = require('./ocr.cjs');

const MiB = 1024 * 1024;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-1867-'));
test.after(() => fs.rmSync(testDir, { recursive: true, force: true }));

/** Page 1 native text, page 2 only an 8x8 gray image (no text layer), plus `padding` bytes of an
 *  unreferenced stream so the file is over the old 25 MiB OCR limit. */
function imagePagePdf(padding) {
  const pixels = Buffer.alloc(64, 0x80);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [4 0 R 6 0 R] /Count 2 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>',
    null, // 5: page 1 content
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 8 0 R >> >> /Contents 7 0 R >>',
    null, // 7: page 2 content
    null, // 8: the image
  ];
  const text = 'BT /F1 12 Tf 72 720 Td (SYN-NATIVE-PAGE-1 synthetic text layer) Tj ET';
  const draw = 'q 612 0 0 792 0 0 cm /Im1 Do Q';
  const parts = [Buffer.from('%PDF-1.4\n')];
  let size = parts[0].length;
  const offsets = [];
  const push = (buf) => { parts.push(buf); size += buf.length; };
  const obj = (n, head, stream) => {
    offsets[n - 1] = size;
    push(Buffer.from(`${n} 0 obj\n${head}${stream ? '\nstream\n' : ''}`));
    if (stream) { push(stream); push(Buffer.from('\nendstream')); }
    push(Buffer.from('\nendobj\n'));
  };
  objects.forEach((body, i) => {
    const n = i + 1;
    if (n === 5) obj(n, `<< /Length ${text.length} >>`, Buffer.from(text));
    else if (n === 7) obj(n, `<< /Length ${draw.length} >>`, Buffer.from(draw));
    else if (n === 8) obj(n, '<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 64 >>', pixels);
    else obj(n, body);
  });
  obj(9, `<< /Length ${padding} >>`, Buffer.alloc(padding, 0x41));
  const xref = size;
  push(Buffer.from(`xref\n0 10\n0000000000 65535 f \n${offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 10 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`));
  return Buffer.concat(parts);
}

const big = imagePagePdf(26 * MiB);
const NEW_WORKER = { maxBytes: 96 * MiB, dpis: [300, 400, 600] };
const native = (extra = {}) => ({ doclingEnabled: false, ocrEnabled: true, waits: [0, 0], env: {}, ...extra });
function fakeOcr(answer) {
  const calls = [];
  const extractPages = async (bytes, pages, options = {}) => {
    calls.push({ bytes: bytes.length, pages: [...pages], dpi: options.dpi });
    return pages.map((n) => ({ number: n, text: answer(n, options) }));
  };
  return { calls, extractPages };
}

test('#1867: OCR capabilities come from /health; an old worker and an unreachable one keep the 25 MB contract', async () => {
  const answer = (body, status = 200) => async (url, options) => {
    assert.equal(url, 'http://ocr.invalid/health');
    assert.equal(options.method, 'GET');
    return new Response(JSON.stringify(body), { status });
  };
  const fresh = { url: 'http://ocr.invalid', fresh: true };
  assert.deepEqual(await ocr.capabilities({ ...fresh, fetchImpl: answer({ service: 'ocr', ranges: true, maxBytes: 96 * MiB, dpis: [300, 400, 600] }) }), NEW_WORKER);
  assert.deepEqual(await ocr.capabilities({ ...fresh, fetchImpl: answer({ service: 'ocr' }) }), {});
  assert.equal(await ocr.capabilities({ ...fresh, fetchImpl: answer({}, 503) }), null);
  assert.equal(await ocr.capabilities({ ...fresh, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } }), null);
  assert.equal(await ocr.capabilities({ url: '' }), null);
  assert.equal(ocr.maxBytesOf(null), 25 * MiB);
  assert.equal(ocr.maxBytesOf({}), 25 * MiB);
  assert.equal(ocr.maxBytesOf({ maxBytes: 1 }), 25 * MiB, 'never below what every worker accepts');
  assert.equal(ocr.maxBytesOf(NEW_WORKER), 96 * MiB);
  assert.equal(ocr.rendersAt(NEW_WORKER, 400), true);
  assert.equal(ocr.rendersAt({}, 400), false);
});

test('#1867: the image-only page of a PDF over 25 MiB is sent to a worker that takes it, and read', async () => {
  assert.ok(big.length > 25 * MiB);
  const fake = fakeOcr((n) => (n === 2 ? 'SYN-SCANNED-ROW REF-2042 TOTAL 34.95' : ''));
  const out = await documents.extractDocumentText('large.pdf', big, native({ extractPages: fake.extractPages, ocrCapabilities: async () => NEW_WORKER }));
  assert.deepEqual(fake.calls, [{ bytes: big.length, pages: [2], dpi: undefined }], 'one pass at the default resolution, the whole file');
  assert.equal(out.pageTexts[1].status, 'ocr');
  assert.match(out.text, /REF-2042/);
  assert.equal(out.errorId, undefined);
  assert.equal(out.state, 'ready');
});

test('#1867: an old worker (no capabilities) is never sent a body over 25 MiB, exactly as before', async () => {
  for (const capabilities of [async () => ({}), async () => null, async () => { throw new Error('down'); }]) {
    const fake = fakeOcr(() => 'must not run');
    const out = await documents.extractDocumentText('large.pdf', big, native({ extractPages: fake.extractPages, ocrCapabilities: capabilities }));
    assert.deepEqual(fake.calls, []);
    assert.equal(out.errorId, 'ocrTooLarge');
    assert.match(out.error, /accepts \(25 MB\)/);
    assert.deepEqual(out.pageTexts[1].retry, { outcome: 'failed', error: 'the PDF is larger than the OCR service accepts (25 MB)' });
    assert.equal(out.completion, documents.COMPLETION);
  }
});

test('#1867: a file over even the advertised limit says that limit', async () => {
  const fake = fakeOcr(() => 'must not run');
  const out = await documents.extractDocumentText('large.pdf', big, native({ extractPages: fake.extractPages, ocrCapabilities: async () => ({ maxBytes: 25 * MiB + 1 }) }));
  assert.deepEqual(fake.calls, []);
  assert.match(out.error, /accepts \(25 MB\)/);
});

test('#1867: a page OCR read at 300 dpi without text is retried once at 400 dpi when the worker renders finer', async () => {
  const scanned = fs.readFileSync(path.join(__dirname, 'fixtures/documents/scanned.pdf'));
  const fake = fakeOcr((_n, options) => (options.dpi === 400 ? 'SYN-FINER INV-2042 34.95' : ''));
  const out = await documents.extractDocumentText('scanned.pdf', scanned, native({ extractPages: fake.extractPages, ocrCapabilities: async () => NEW_WORKER }));
  assert.deepEqual(fake.calls.map(({ pages, dpi }) => ({ pages, dpi })), [{ pages: [1], dpi: undefined }, { pages: [1], dpi: 400 }]);
  assert.equal(out.pageTexts[0].retry.outcome, 'recovered');
  assert.equal(out.pageTexts[0].status, 'ocr');
  assert.match(out.text, /INV-2042/);
  assert.equal(out.completion, documents.COMPLETION);
  // Bounded: the stored result is complete, and reading it again does not OCR again.
  const again = await documents.completeDocument('scanned.pdf', scanned, out, native({ extractPages: fake.extractPages, ocrCapabilities: async () => NEW_WORKER }));
  assert.equal(again, out);
  assert.equal(fake.calls.length, 2);
  // A worker that ignores X-OCR-DPI is not asked for the same 300 dpi pass twice (#1871 unchanged).
  const old = fakeOcr(() => '');
  await documents.extractDocumentText('scanned.pdf', scanned, native({ extractPages: old.extractPages, ocrCapabilities: async () => ({}) }));
  assert.deepEqual(old.calls.map(({ dpi }) => dpi), [undefined]);
});

test('#1867: a result completed while OCR refused its size is re-opened once the worker takes it', async () => {
  const stored = await documents.extractDocumentText('large.pdf', big, native({ extractPages: async () => { throw new Error('must not run'); }, ocrCapabilities: async () => ({}) }));
  assert.equal(documents.reopenable(stored), true);
  // Still an old worker: nothing is done, and the very same record comes back (nothing is rewritten).
  assert.equal(await documents.completeDocument('large.pdf', big, stored, native({ ocrCapabilities: async () => ({}) })), stored);
  const fake = fakeOcr((n) => (n === 2 ? 'SYN-SCANNED-ROW REF-2042' : ''));
  const out = await documents.completeDocument('large.pdf', big, stored, native({ extractPages: fake.extractPages, ocrCapabilities: async () => NEW_WORKER }));
  assert.deepEqual(fake.calls.map(({ pages, dpi }) => ({ pages, dpi })), [{ pages: [2], dpi: 400 }]);
  assert.equal(out.pageTexts[1].retry.outcome, 'recovered');
  assert.equal(out.state, 'ready');
  assert.equal(out.error, undefined);
  assert.equal(out.errorId, undefined);
  assert.equal(out.completion, documents.COMPLETION);
  assert.equal(documents.reopenable(out), false, 'once');
  assert.match(out.text, /REF-2042/);
  assert.match(out.text, /SYN-NATIVE-PAGE-1/, 'the text layer that was read is kept');
});

test('#1867: a stored source record is re-opened through ingest when the OCR worker now takes the file', async () => {
  const workspace = { dir: path.join(testDir, 'ws-reopen'), assertActive: () => {} };
  const realExtract = documents.extractDocumentText, realComplete = documents.completeDocument;
  let caps = {};
  const fake = fakeOcr((n) => (n === 2 ? 'SYN-SCANNED-ROW REF-2042' : ''));
  documents.extractDocumentText = (name, b) => realExtract(name, b, native({ extractPages: fake.extractPages, ocrCapabilities: async () => caps }));
  documents.completeDocument = (name, b, out) => realComplete(name, b, out, native({ extractPages: fake.extractPages, ocrCapabilities: async () => caps }));
  try {
    const first = await documentSources.ingest(workspace, 'p1', 'Inspections/large.pdf', big, null);
    assert.equal(first.document.state, 'partial');
    assert.equal(first.document.errorId, 'ocrTooLarge');
    const unchanged = await documentSources.ingest(workspace, 'p1', 'Inspections/large.pdf', big, first);
    assert.equal(unchanged.document.errorId, 'ocrTooLarge');
    assert.equal(fake.calls.length, 0);
    caps = NEW_WORKER; // the sidecar was updated
    const second = await documentSources.ingest(workspace, 'p1', 'Inspections/large.pdf', big, unchanged);
    assert.equal(second.document.version, first.document.version, 'same version: nothing else is re-read');
    assert.equal(second.document.state, 'ready');
    assert.equal(second.document.errorId, undefined);
    assert.ok(second.content.includes('REF-2042'));
    await documentSources.ingest(workspace, 'p1', 'Inspections/large.pdf', big, second);
    assert.equal(fake.calls.length, 1, 'bounded: once');
  } finally { documents.extractDocumentText = realExtract; documents.completeDocument = realComplete; }
});

test('#1867: a small PDF never asks the worker what it accepts; the default request is unchanged', async () => {
  const scanned = fs.readFileSync(path.join(__dirname, 'fixtures/documents/scanned.pdf'));
  let asked = 0;
  const fake = fakeOcr(() => 'SYN-TEXT INV-2042');
  const out = await documents.extractDocumentText('scanned.pdf', scanned, native({ extractPages: fake.extractPages, ocrCapabilities: async () => { asked++; return NEW_WORKER; } }));
  assert.equal(asked, 0);
  assert.deepEqual(fake.calls.map(({ pages, dpi }) => ({ pages, dpi })), [{ pages: [1], dpi: undefined }]);
  assert.equal(out.state, 'ready');
});

// ── #1882: review follow-ups ─────────────────────────────────────────────────────────────────────
test('#1882: the first-pass OCR of a file over 25 MiB spends the sync budget and resumes on a later sync', async () => {
  const fake = fakeOcr((n) => (n === 2 ? 'SYN-SCANNED-ROW REF-2042' : ''));
  const spent = { remaining: 0 };
  const out = await documents.extractDocumentText('large.pdf', big, native({ extractPages: fake.extractPages, ocrCapabilities: async () => NEW_WORKER, ocrBudget: spent }));
  assert.deepEqual(fake.calls, [], 'no budget left: nothing sent');
  assert.equal(out.pageTexts[1].status, 'ocr-needed');
  assert.equal(out.completion, undefined, 'left open for a later sync');
  assert.notEqual(out.errorId, 'ocrPageLimit');
  const later = { remaining: 40 };
  const done = await documents.completeDocument('large.pdf', big, out, native({ extractPages: fake.extractPages, ocrCapabilities: async () => NEW_WORKER, ocrBudget: later }));
  assert.equal(fake.calls.length, 1);
  assert.equal(later.remaining, 39);
  assert.equal(done.pageTexts[1].retry.outcome, 'recovered');
  assert.equal(done.completion, documents.COMPLETION);
  // With budget the first pass sends at once and spends it.
  const budget = { remaining: 40 };
  const fresh = fakeOcr((n) => (n === 2 ? 'SYN-SCANNED-ROW' : ''));
  await documents.extractDocumentText('large.pdf', big, native({ extractPages: fresh.extractPages, ocrCapabilities: async () => NEW_WORKER, ocrBudget: budget }));
  assert.deepEqual(fresh.calls.map((c) => c.pages), [[2]]);
  assert.equal(budget.remaining, 39);
});

test('#1882: 400-dpi retries go in small batches with a timeout scaled to the batch, and a timeout is not final', async () => {
  const pages = Array.from({ length: 7 }, (_, i) => ({ number: i + 1, text: 'x', status: 'degraded', method: 'docling' }));
  const first = { text: 'x', pages: 7, state: 'partial', truncated: false, retryable: false, pageTexts: pages };
  const seen = [];
  const extractPages = async (_b, numbers, options) => { seen.push({ numbers: [...numbers], dpi: options.dpi, timeoutMs: options.timeoutMs }); return numbers.map((n) => ({ number: n, text: 'SYN' })); };
  await documents.completeDocument('form.pdf', Buffer.from('%PDF-1.4 synthetic'), first, { doclingEnabled: false, ocrEnabled: true, extractPages, waits: [0, 0], env: {}, ocrCapabilities: async () => NEW_WORKER });
  assert.deepEqual(seen.map((c) => c.numbers.length), [3, 3, 1]);
  assert.ok(seen.every((c) => c.dpi === 400 && c.timeoutMs === documents.retryTimeoutMs(c.numbers.length)));
  assert.ok(documents.retryTimeoutMs(3) >= 600_000, 'never below the worker’s own 600 s budget');
  assert.ok(documents.retryTimeoutMs(1) < documents.retryTimeoutMs(3));
  const timedOut = await documents.completeDocument('form.pdf', Buffer.from('%PDF-1.4 synthetic'), { ...first, pageTexts: pages.slice(0, 1).map((p) => ({ ...p })) },
    { doclingEnabled: false, ocrEnabled: true, waits: [0, 0], env: {}, ocrCapabilities: async () => NEW_WORKER,
      extractPages: async () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); } });
  assert.equal(timedOut.pageTexts[0].retry.again, true, 'tried again on a later read');
  assert.equal(timedOut.completion, undefined);
});

test('#1882: core never asks for 600 dpi', async () => {
  const headers = [];
  const fetchImpl = async (_url, options) => { headers.push(options.headers['X-OCR-DPI']); return new Response(JSON.stringify({ pages: [] })); };
  for (const dpi of [600, 400, undefined]) await ocr.extractPages(Buffer.from('x'), [1], { url: 'http://ocr.invalid', fetchImpl, dpi });
  assert.deepEqual(headers, [undefined, '400', undefined]);
});

test('#1882: capability answers, positive and negative, are cached for minutes', async () => {
  let asked = 0;
  const down = async () => { asked++; throw new Error('ECONNREFUSED'); };
  assert.equal(await ocr.capabilities({ url: 'http://ocr-down.invalid', fetchImpl: down }), null);
  assert.equal(await ocr.capabilities({ url: 'http://ocr-down.invalid', fetchImpl: down }), null);
  assert.equal(asked, 1, 'a failed /health is not asked again every sync');
  const old = async () => { asked++; return new Response(JSON.stringify({ service: 'ocr' })); };
  assert.deepEqual(await ocr.capabilities({ url: 'http://ocr-old.invalid', fetchImpl: old }), {});
  assert.deepEqual(await ocr.capabilities({ url: 'http://ocr-old.invalid', fetchImpl: old }), {});
  assert.equal(asked, 2);
  assert.ok(ocr.CAPABILITY_TTL_MS >= 3 * 60_000);
  const docling = require('./docling.cjs');
  let doclingAsked = 0;
  const gone = async () => { doclingAsked++; return new Response('', { status: 503 }); };
  assert.equal(await docling.rangesSupported({ url: 'http://docling-down.invalid', fetchImpl: gone }), null);
  assert.equal(await docling.rangesSupported({ url: 'http://docling-down.invalid', fetchImpl: gone }), null);
  assert.equal(doclingAsked, 1);
});

test('#1882: a ranged body is never sent above Docling’s advertised rangedMaxBytes', async () => {
  const docling = require('./docling.cjs');
  const health = async () => new Response(JSON.stringify({ service: 'docling', ranges: true, rangedMaxBytes: 30 * MiB }));
  const opts = (bytes) => ({ url: 'http://docling-cap.invalid', fetchImpl: health, fresh: true, bytes });
  assert.equal(await docling.rangesSupported(opts(29 * MiB)), true);
  assert.equal(await docling.rangesSupported(opts(31 * MiB)), false);
  assert.equal(await docling.rangesSupported({ url: 'http://docling-cap.invalid', fetchImpl: health, fresh: true }), true);
  // documents asks with the file's size, and reads a file over the cap here instead of through Docling.
  const asked = [];
  let sent = 0;
  const out = await documents.extractDocumentText('large.pdf', big, { doclingEnabled: true, ocrEnabled: false, waits: [0, 0], env: {},
    rangesSupported: async (o) => { asked.push(o?.bytes); return false; }, extractDocument: async () => { sent++; return {}; } });
  assert.deepEqual(asked, [big.length]);
  assert.equal(sent, 0);
  assert.equal(out.pageTexts[0].status, 'native');
});
