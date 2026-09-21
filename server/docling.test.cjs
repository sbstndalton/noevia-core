'use strict';
// The Docling worker itself is not exercised here — it needs ~1.6 GB of models
// and a container. What is exercised is everything noevia owns: which files are
// sent, how the worker's answers map onto the source state machine, and which
// failures are permanent (cache the failure, keep the original) versus
// retryable (do NOT cache it — a busy worker is not a broken document).
//
// services/docling/selftest.py covers the one thing this cannot: that Docling's
// real output is what extract.py assumes.
const test = require('node:test');
const assert = require('node:assert/strict');
const docling = require('./docling.cjs');
const documents = require('./documents.cjs');

// ── client ───────────────────────────────────────────────────────────────

test('the formats that used to be accepted and silently dropped are now sent', () => {
  for (const name of ['q3.xlsx', 'deck.pptx', 'memo.odt', 'book.epub', 'report.pdf', 'scan.TIFF']) {
    assert.equal(docling.supports(name), true, name);
  }
  for (const name of ['bundle.zip', 'firmware.bin', 'noextension', '']) {
    assert.equal(docling.supports(name), false, name);
  }
});

const captured = () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, ...options });
    return { ok: true, json: async () => ({ pages: [], total: 0 }) };
  };
  return { calls, fetchImpl };
};

test('bytes go only to the configured worker, with the name in a header and no redirects', async () => {
  const { calls, fetchImpl } = captured();
  await docling.extractDocument('q3 report.xlsx', Buffer.from('bytes'), { url: 'http://worker.invalid/', fetchImpl });
  assert.equal(calls[0].url, 'http://worker.invalid/extract');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].redirect, 'error', 'a redirect must not carry document bytes elsewhere');
  assert.equal(calls[0].headers['X-Document-Name'], 'q3 report.xlsx');
  assert.ok(calls[0].signal, 'the request is bounded by a timeout');
});

test('with no worker configured, nothing is sent anywhere', async () => {
  await assert.rejects(
    () => docling.extractDocument('a.pdf', Buffer.from('x'), { url: '', fetchImpl: () => { throw new Error('must not be called'); } }),
    /not configured/);
});

test('a long name is truncated rather than rejected by the worker', async () => {
  const { calls, fetchImpl } = captured();
  await docling.extractDocument('a'.repeat(500) + '.pdf', Buffer.from('x'), { url: 'http://w.invalid', fetchImpl });
  assert.equal(calls[0].headers['X-Document-Name'].length, 200);
});

test('permanent and retryable worker failures are distinguished', async () => {
  const reply = (status) => async () => ({ ok: false, status });
  const call = (status) => docling.extractDocument('a.pdf', Buffer.from('x'), { url: 'http://w.invalid', fetchImpl: reply(status) });

  // 503/500 are retryable: the document is fine, the worker is not.
  await assert.rejects(call(503), (e) => e.permanent !== true && /busy/.test(e.message));
  await assert.rejects(call(500), (e) => e.permanent !== true && /refresh to retry/.test(e.message));
  // 415/422 are the document: caching the failure is correct.
  await assert.rejects(call(415), (e) => e.permanent === true);
  await assert.rejects(call(422), (e) => e.permanent === true);
});

test('a malformed worker response is an error, not a silently empty document', async () => {
  await assert.rejects(
    () => docling.extractDocument('a.pdf', Buffer.from('x'), {
      url: 'http://w.invalid', fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true }) }) }),
    /Invalid extraction response/);
});

// ── routing in documents.cjs ─────────────────────────────────────────────

const withWorker = (extractDocument) => (name, bytes = Buffer.from('x')) =>
  documents.extractDocumentText(name, bytes, { doclingEnabled: true, extractDocument });

const page = (number, text, status = 'native') => ({ number, text, status, truncated: false });

test('a converted document becomes the same shape the PDF path produces', async () => {
  const run = withWorker(async () => ({ pages: [page(1, 'first page'), page(2, 'second page')], total: 2 }));
  const out = await run('deck.pptx');
  assert.equal(out.state, 'ready');
  assert.equal(out.pages, 2);
  assert.equal(out.truncated, false);
  assert.equal(out.retryable, false);
  assert.match(out.text, /\[Page 1\]\nfirst page\n\n\[Page 2\]\nsecond page/);
  assert.deepEqual(out.pageTexts.map((p) => p.method), ['docling', 'docling']);
});

test('table markdown from the worker survives into the extracted text', async () => {
  // The whole reason for the change: structure has to reach the chunker.
  const table = '| item | qty |\n| --- | --- |\n| bolt | 4 |';
  const run = withWorker(async () => ({ pages: [page(1, `Parts\n\n${table}`)], total: 1 }));
  assert.ok((await run('parts.xlsx')).text.includes(table));
});

test('a blank page is partial, not failed, and keeps the readable pages', async () => {
  const run = withWorker(async () => ({ pages: [page(1, 'readable'), page(2, '', 'blank')], total: 2 }));
  const out = await run('a.pdf');
  assert.equal(out.state, 'ready', 'blank is an expected page state, not an incomplete one');
  assert.match(out.text, /\[Page 2\]\n\(blank\)/);
});

test('a truncated page marks the document partial', async () => {
  const run = withWorker(async () => ({ pages: [{ ...page(1, 'x'), status: 'truncated', truncated: true }], total: 1 }));
  const out = await run('a.pdf');
  assert.equal(out.state, 'partial');
  assert.equal(out.truncated, true);
});

test('more pages than the cap is reported as partial rather than silently short', async () => {
  const run = withWorker(async () => ({ pages: [page(1, 'only one')], total: 900, truncatedPages: true }));
  const out = await run('long.pdf');
  assert.equal(out.state, 'partial');
  assert.equal(out.pages, 900, 'the real length is reported, not the capped one');
});

test('a busy worker is retryable and yields no cached failure', async () => {
  const run = withWorker(async () => { throw new Error('Document extraction is busy; refresh to retry.'); });
  const out = await run('a.pdf');
  assert.equal(out.retryable, true);
  assert.equal(out.state, 'failed');
  assert.match(out.error, /busy/);
});

test('an unreadable document throws 422 so the original is stored and labelled', async () => {
  const run = withWorker(async () => { throw Object.assign(new Error('This document could not be read; the original is stored.'), { permanent: true }); });
  await assert.rejects(() => run('a.pdf'), (e) => e.status === 422);
});

test('a file the worker cannot read is refused before any bytes are sent', async () => {
  await assert.rejects(
    () => documents.extractDocumentText('bundle.zip', Buffer.from('x'),
      { doclingEnabled: true, extractDocument: () => { throw new Error('must not be called'); } }),
    (e) => e.status === 400);
});

test('with Docling off, the PDF-only gate and the pdf.js path are unchanged', async () => {
  // The default install must behave exactly as before, not degrade.
  assert.equal(documents.isDocument('a.pdf'), true);
  assert.equal(documents.isDocument('a.xlsx'), false);
  assert.deepEqual(documents.documentExtensions(), ['.pdf']);
  await assert.rejects(() => documents.extractDocumentText('a.xlsx', Buffer.from('x')), (e) => e.status === 400);
});

test('a storage path is sent as a file name, because the worker refuses anything path-shaped', async () => {
  // Found in production: every document inside a folder failed with HTTP 400 while a file at
  // the root worked. noevia's names are paths; the worker reads the suffix and rejects "/".
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push(init.headers['X-Document-Name']);
    return { ok: true, json: async () => ({ pages: [{ page: 1, text: 'x' }], total: 1 }) };
  };
  for (const name of ['Documents/Important Documents/Tax Return 2024/2024 W-2.pdf', 'plain.pdf', 'a\\b\\c.PDF']) {
    await docling.extractDocument(name, Buffer.from("x"), { url: 'http://docling.test', fetchImpl });
  }
  assert.deepEqual(sent, ['2024 W-2.pdf', 'plain.pdf', 'c.PDF']);
  for (const name of sent) assert.ok(!name.includes('/') && !name.includes('\\') && name.length <= 200);
});

test('a refusal noevia caused is named as that, and never cached as permanent', async () => {
  // Permanent means "this document cannot be read". A 400 means noevia sent it wrongly, and
  // caching that would outlive the fix -- which is exactly what happened when every document
  // inside a folder was sent with its path as its name.
  const fetchImpl = async () => ({ ok: false, status: 400, json: async () => ({}) });
  await assert.rejects(
    () => docling.extractDocument('x.pdf', Buffer.from('x'), { url: 'http://docling.test', fetchImpl }),
    (error) => !error.permanent && /noevia sent this document/.test(error.message),
  );
});
