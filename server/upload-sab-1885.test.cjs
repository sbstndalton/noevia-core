'use strict';
// #1885: a large file read from storage lands in a SharedArrayBuffer (storage-client.cjs, #1871), and
// Node 22's fetch refuses such a body. No test combined that read with an upload, so every OCR and
// Docling upload of a large PDF failed live. These drive the real storage read into the real upload
// clients, against fake sidecars that, like the real ones, refuse a body without a Content-Length.
// Synthetic bytes only.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const dns = require('node:dns');
const crypto = require('node:crypto');
const storage = require('./storage-client.cjs');
const ocr = require('./ocr.cjs');
const docling = require('./docling.cjs');
const docx = require('./docx.cjs');
const pdfReduce = require('./pdf-reduce.cjs');
const documents = require('./documents.cjs');
const { uploadInit, isShared } = require('./upload-body.cjs');
const { sendWithLookup } = require('./public-fetch.cjs');

const MiB = 1024 * 1024;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** Synthetic bytes: a PDF header then a position-dependent pattern, so a reordered or dropped slice shows. */
function syntheticBytes(size) {
  const b = Buffer.allocUnsafe(size);
  for (let i = 0; i + 4 <= size; i += 4) b.writeUInt32LE((i * 2654435761) >>> 0, i);
  b.fill(7, size - (size % 4)); b.write("%PDF-1.4\n", 0);
  return b;
}

/** The real large read: storage-client readBinaryFile, the storage answering with a declared length. */
async function sharedRead(source) {
  const realFetch = global.fetch;
  global.fetch = async () => new Response(new ReadableStream({
    start(c) { for (let at = 0; at < source.length; at += MiB) c.enqueue(source.subarray(at, Math.min(source.length, at + MiB))); c.close(); },
  }), { headers: { 'content-length': String(source.length) } });
  try {
    const conn = { kind: 'webdav', baseUrl: 'http://fixture.invalid/dav', username: 'synthetic', secret: 'synthetic' };
    return await storage.readBinaryFile(conn, 'big.pdf', { cap: 96 * MiB });
  } finally { global.fetch = realFetch; }
}

/** A sidecar that, like the real ones, answers 411 to a body without Content-Length (or a chunked one),
 *  hashes what it receives without keeping it, and answers like the OCR / Docling / DOCX workers. */
async function fakeSidecar() {
  const seen = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && (req.headers['content-length'] === undefined || req.headers['transfer-encoding'])) {
      seen.push({ path: req.url, refused: true }); req.resume(); res.writeHead(411); res.end(); return;
    }
    const h = crypto.createHash('sha256'); let n = 0;
    req.on('data', (c) => { h.update(c); n += c.length; });
    req.on('end', () => {
      seen.push({ path: req.url, length: Number(req.headers['content-length']), received: n, hash: h.digest('hex') });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/extract' && req.headers['x-ocr-pages']) {
        const pages = JSON.parse(req.headers['x-ocr-pages']);
        res.end(JSON.stringify({ pages: pages.map((number) => ({ number, text: `SYN-OCR-${number}` })) }));
      } else if (req.url === '/extract') {
        const [a, b] = String(req.headers['x-document-pages'] || '1-1').split('-').map(Number);
        const pages = []; for (let p = a; p <= b; p++) pages.push({ number: p, text: `SYN-DOC-${p}` });
        res.end(JSON.stringify({ pages, total: b }));
      } else if (req.url === '/extract-docx') res.end(JSON.stringify({ text: 'SYN-DOCX', truncated: false }));
      else { res.writeHead(404); res.end('{}'); }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((r) => server.close(r)) };
}

const source = syntheticBytes(40 * MiB + 12345);
let shared;
test.before(async () => { shared = await sharedRead(source); });

test('#1885: the real large read is SAB-backed (the case every upload must survive)', () => {
  assert.ok(shared.buffer instanceof SharedArrayBuffer);
  assert.ok(isShared(shared));
  assert.equal(shared.length, source.length);
});

test('#1885: hashing SAB-backed bytes works and equals hashing a copy', () => {
  assert.equal(sha(shared), sha(source));
  assert.equal(sha(shared.subarray(5, 5 * MiB)), sha(source.subarray(5, 5 * MiB)));
});

test('#1885: OCR upload of a SAB-backed read reaches the worker with Content-Length and identical bytes', async () => {
  const side = await fakeSidecar();
  try {
    const pages = await ocr.extractPages(shared, [1, 2], { url: side.url, dpi: 400 });
    assert.deepEqual(pages.map((p) => p.text), ['SYN-OCR-1', 'SYN-OCR-2']);
    const [hit] = side.seen;
    assert.ok(!hit.refused, 'sent with a Content-Length, not chunked');
    assert.equal(hit.length, source.length);
    assert.equal(hit.received, source.length);
    assert.equal(hit.hash, sha(source));
  } finally { await side.close(); }
});

test('#1885: Docling ranged upload of a SAB-backed read succeeds with identical bytes', async () => {
  const side = await fakeSidecar();
  try {
    const body = await docling.extractDocument('Documents/big.pdf', shared, { url: side.url, pages: [3, 5] });
    assert.deepEqual(body.pages.map((p) => p.number), [3, 4, 5]);
    const [hit] = side.seen;
    assert.ok(!hit.refused);
    assert.equal(hit.length, source.length);
    assert.equal(hit.hash, sha(source));
  } finally { await side.close(); }
});

test('#1885: DOCX and PDF-reduce uploads accept SAB-backed bytes too', async () => {
  const side = await fakeSidecar();
  try {
    const r = await docx.extract(shared, { url: side.url });
    assert.equal(r.text, 'SYN-DOCX');
    // pdf-reduce's reply format is its own; what matters here is that the body got there whole.
    await pdfReduce.prepare('big.pdf', shared, { url: side.url }).catch(() => {});
    const hits = side.seen.filter((s) => !s.refused);
    assert.ok(side.seen.every((s) => !s.refused), 'no upload went without a Content-Length');
    assert.equal(hits.length, 2, 'both reached their worker');
    for (const h of hits) assert.equal(h.hash, sha(source));
  } finally { await side.close(); }
});

test('#1885: the machine-assigned fetch (sendWithLookup) sends the sized stream with its Content-Length', async () => {
  const side = await fakeSidecar();
  try {
    const url = new URL(`${side.url}/extract`);
    const res = await sendWithLookup(url, uploadInit(shared, { method: 'POST', headers: { 'X-OCR-Pages': '[1]' } }), dns.lookup);
    assert.equal(res.status, 200);
    await res.json();
    assert.equal(side.seen[0].length, source.length);
    assert.equal(side.seen[0].hash, sha(source));
    // and through ocr.extractPages with that fetch, as a machine-assigned worker is reached
    const pages = await ocr.extractPages(shared, [7], { url: side.url, fetchImpl: (u, init) => sendWithLookup(new URL(u), init, dns.lookup) });
    assert.equal(pages[0].text, 'SYN-OCR-7');
    assert.equal(side.seen[1].hash, sha(source));
  } finally { await side.close(); }
});

test('#1885: ordinary bytes are sent exactly as before (no stream)', () => {
  const plain = Buffer.from('%PDF-small');
  const init = uploadInit(plain, { method: 'POST', headers: { a: 'b' } });
  assert.equal(init.body, plain);
  assert.equal(init.duplex, undefined);
  assert.deepEqual(init.headers, { a: 'b' });
});

test('#1885: uploading a SAB-backed read keeps memory bounded (no second copy of the file)', async () => {
  const big = await sharedRead(syntheticBytes(80 * MiB));
  const side = await fakeSidecar();
  global.gc?.();
  const before = process.memoryUsage.rss();
  let peak = before;
  const watch = setInterval(() => { peak = Math.max(peak, process.memoryUsage.rss()); }, 5);
  try {
    await ocr.extractPages(big, [1], { url: side.url });
  } finally { clearInterval(watch); await side.close(); }
  const growth = (peak - before) / MiB;
  console.log(`[#1885 memory] 80 MiB SAB upload: peak RSS growth ${growth.toFixed(1)} MiB`);
  // A whole copy would add 80 MiB; slices of 1 MiB add a few.
  assert.ok(growth < 40, `peak growth ${growth.toFixed(1)} MiB stays well under the file's 80 MiB`);
});

test('#1885: raw JS errors become a short reason; worded and worker errors are kept', () => {
  const warn = console.warn; const logged = [];
  console.warn = (...a) => logged.push(a.join(' '));
  try {
    const sab = documents.userReason(new TypeError('ArrayBuffer: SharedArrayBuffer is not allowed.'), 'OCR retry');
    assert.doesNotMatch(sab, /ArrayBuffer/);
    assert.match(sab, /internal error/);
    assert.match(documents.userReason(new TypeError("Cannot read properties of undefined (reading 'x')"), 'OCR'), /internal error/);
    assert.equal(documents.userReason(new TypeError('fetch failed'), 'OCR'), 'fetch failed');
    assert.equal(documents.userReason(new Error('OCR is busy; refresh to retry.'), 'OCR'), 'OCR is busy; refresh to retry.');
    assert.equal(logged.length, 2);
    assert.match(logged[0], /SharedArrayBuffer/);
  } finally { console.warn = warn; }
});

// The record a large PDF was left with on eb5a4523: page 1 incomplete, its OCR retry "failed" with the raw
// SAB error, the completion marker set (so nothing would ever look at it again).
const stuckRecord = () => ({
  text: 'SYN-PAGE-2', pages: 2, state: 'partial', truncated: false, retryable: false, completion: documents.COMPLETION,
  pageTexts: [
    { number: 1, text: '', status: 'ocr-needed', method: 'native', retry: { outcome: 'failed', dpi: 400, error: 'ArrayBuffer: SharedArrayBuffer is not allowed.', attempts: 1 } },
    { number: 2, text: 'SYN-PAGE-2', status: 'ready', method: 'native' },
  ],
});

test('#1885: a record that failed with the SAB error is reopened, retried through the real upload, then final', async () => {
  const side = await fakeSidecar();
  try {
    const stored = stuckRecord();
    assert.equal(documents.reopenable(stored), true, 'the sync gate (document-sources ingest) reopens it');
    const deps = { ocrEnabled: true, doclingEnabled: false, waits: [0, 0], env: {},
      ocrCapabilities: async () => ({ maxBytes: 96 * MiB, dpis: [400] }),
      extractPages: (b, p, o) => ocr.extractPages(b, p, { ...o, url: side.url }) };
    const done = await documents.completeDocument('big.pdf', shared, stored, deps);
    assert.equal(side.seen.length, 1, 'retried once, through the worker');
    assert.equal(side.seen[0].hash, sha(source));
    const page1 = done.pageTexts.find((p) => p.number === 1);
    assert.equal(page1.retry.outcome, 'recovered');
    assert.match(page1.text, /SYN-OCR-1/);
    assert.equal(done.completion, documents.COMPLETION);
    assert.equal(documents.reopenable(done), false, 'and not reopened again');
  } finally { await side.close(); }
});

test('#1885: if the reopened retry fails again, the reason is short and it is not reopened a second time', async () => {
  const warn = console.warn; console.warn = () => {};
  try {
    const deps = { ocrEnabled: true, doclingEnabled: false, waits: [0, 0], env: {},
      ocrCapabilities: async () => ({ maxBytes: 96 * MiB, dpis: [400] }),
      extractPages: async () => { throw new TypeError('ArrayBuffer: SharedArrayBuffer is not allowed.'); } };
    const done = await documents.completeDocument('big.pdf', shared, stuckRecord(), deps);
    const page1 = done.pageTexts.find((p) => p.number === 1);
    assert.equal(page1.retry.outcome, 'failed');
    assert.doesNotMatch(page1.retry.error, /ArrayBuffer/);
    assert.equal(documents.reopenable(done), false);
  } finally { console.warn = warn; }
});

test('#1885: a range read stopped by the SAB error resumes on the next read', () => {
  const stored = { ...stuckRecord(), pageTexts: [{ number: 1, text: 'SYN-PAGE-1', status: 'ready', method: 'docling' }], pages: 400,
    stoppedAt: { page: 1, limit: 'error', error: 'ArrayBuffer: SharedArrayBuffer is not allowed.' }, rangeAttempts: 1 };
  assert.equal(documents.reopenable(stored), true);
  const reopened = documents.reopenSabFailure(stored);
  assert.equal(reopened.completion, undefined);
  assert.equal(reopened.stoppedAt, undefined);
  assert.equal(reopened.rangeAttempts, undefined);
  assert.equal(reopened.pageTexts[0].text, 'SYN-PAGE-1', 'what was read is kept');
});
