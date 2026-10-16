'use strict';
// #1885 follow-up: a large PDF whose stored result failed with the shared-memory upload error was never
// reopened by "Refresh from storage". The stored shape (live, status fields only): the source record is
// `state: 'failed', stale: true` with the raw body-read timeout as its error ("Refresh failed · using
// previous text"), and the stored result is complete (`completion` set) with every page's OCR retry failed
// with "SharedArrayBuffer is not allowed". The sync reaches the reopen (document-sources ingest) only after
// the storage read succeeds; a read that timed out went straight to `failed()`, silently, every time.
// These drive the real sync route and the real ingest/completion pass against a fake OCR sidecar.
// Synthetic bytes and text only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const documents = require('./documents.cjs');
const documentSources = require('./document-sources.cjs');
const storage = require('./storage-client.cjs');

const MiB = 1024 * 1024;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-sync-reopen-'));
test.after(() => fs.rmSync(testDir, { recursive: true, force: true }));

const FOLDER = 'synthetic-folder';
const NAME = `${FOLDER}/synthetic-large.pdf`;
const PAGES = 9;
const SAB_ERROR = 'ArrayBuffer: SharedArrayBuffer is not allowed.';
const RAW_TIMEOUT = 'The operation was aborted due to timeout';

/** Synthetic bytes over the 25 MiB large-document line: a PDF header then a position-dependent pattern. */
function syntheticBytes(size) {
  const b = Buffer.allocUnsafe(size);
  for (let i = 0; i + 4 <= size; i += 4) b.writeUInt32LE((i * 2654435761) >>> 0, i);
  b.fill(7, size - (size % 4)); b.write('%PDF-1.4\n', 0);
  return b;
}
const bytes = syntheticBytes(26 * MiB + 4321);

/** An OCR worker like the real one: /health says it reads ranges and takes large bodies; /extract with
 *  X-OCR-Pages answers each page; a body without Content-Length is refused (411). */
async function fakeOcr() {
  const seen = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, ranges: true, maxBytes: 96 * MiB, dpis: [300, 400] })); return;
    }
    if (req.method === 'POST' && (req.headers['content-length'] === undefined || req.headers['transfer-encoding'])) {
      seen.push({ refused: true }); req.resume(); res.writeHead(411); res.end(); return;
    }
    const h = crypto.createHash('sha256');
    req.on('data', (c) => h.update(c));
    req.on('end', () => {
      const pages = JSON.parse(req.headers['x-ocr-pages'] || '[]');
      seen.push({ path: req.url, pages, hash: h.digest('hex') });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ pages: pages.map((number) => ({ number, text: `SYN-OCR-${number} total 42.15` })) }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((r) => server.close(r)) };
}

let workspaceNumber = 0;
/** The real sync route over a synthetic attached folder holding one large PDF, seeded with the live shape. */
function harness({ read }) {
  const project = { id: 'synthetic-finance', files: [], sourceFolders: [FOLDER] };
  const workspace = { assetDir: (id) => path.join(testDir, 'assets', id), dir: path.join(testDir, String(++workspaceNumber)), userId: 'synthetic-user', projects: [project], saveProjects: () => {} };
  let reads = 0;
  const storageClient = {
    TEXT_EXTENSIONS: new Set(['.txt']), isBrowsable: () => true,
    listFiles: async (_conn, dir) => (dir === FOLDER ? [{ name: 'synthetic-large.pdf', path: NAME, ext: '.pdf', size: bytes.length }] : []),
    readBinaryFile: async (...args) => { reads += 1; return read(...args); },
    storageFailure: storage.storageFailure,
  };
  const shared = {
    fs, path, documentSources, storageClient,
    rag: { indexProjectFile: async () => {}, deleteProjectFile: () => {} },
    authService: { getStorage: () => ({ kind: 'webdav' }) }, currentWorkspace: () => workspace, PROJECTS: [project],
  };
  const store = {
    ...require('./projects.cjs').createProjectStore({ ...shared, reasoningEffort: {}, projectAppearance: () => ({}), FREE_CHATS: [], sanitizeToolboxes: () => null, defaultToolboxes: () => [], PROJECT_ROOT_FOLDER: 'synthetic-root', createProjectFolder: async () => null, projectSweep: { afterDelete: async () => {} } }),
    getProject: (id) => (id === project.id ? project : null), saveProjects: () => {},
  };
  let last;
  const routes = require('./routes/projects.cjs').createProjectRoutes({
    ...shared, store, requestScope: { getStore: () => ({}) }, dispatch: async () => {},
    readJson: async (req) => req.body, readBody: async (req) => JSON.stringify(req.body),
    json: (_res, status, body) => { last = { status, body }; },
    documents, reasoningEffort: {}, projectAppearance: () => ({}), diaryExtras: {}, DEFAULT_TOOLBOXES: [], sanitizeToolboxes: () => null, getProvider: () => null, ensureRolesLoaded: () => {},
  });
  const sync = async () => {
    const p = `/api/projects/${project.id}/sources/sync`;
    last = undefined;
    await routes({ method: 'POST', headers: {} }, {}, { path: p, authn: { user: { id: 'synthetic-user' } }, url: new URL('http://localhost' + p) });
    return last;
  };
  return { project, workspace, sync, reads: () => reads };
}

/** Seed the stored original, the stored result and the source record exactly as found live (synthetic). */
function seedLiveShape(h) {
  const byteHash = sha(bytes);
  const version = sha(byteHash + ':' + documents.EXTRACTOR_VERSION);
  const dir = documentSources.directory(h.workspace, h.project.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, byteHash + '.pdf'), bytes);
  const pageTexts = Array.from({ length: PAGES }, (_, i) => ({ number: i + 1, text: '', status: 'ocr-needed', method: 'native',
    retry: { outcome: 'failed', dpi: documents.RETRY_DPI, error: SAB_ERROR, attempts: 1 } }));
  pageTexts[0].text = 'SYN-NATIVE-1';
  const result = { completion: documents.COMPLETION, pageTexts, pages: PAGES, retryable: false, state: 'partial', text: 'SYN-NATIVE-1', truncated: false };
  fs.writeFileSync(path.join(dir, version + '.json'), JSON.stringify(result));
  assert.equal(documents.reopenable(result), true, 'the stored result is the #1885 reopenable shape');
  h.project.files = [{ name: NAME, source: FOLDER, content: 'SYN-NATIVE-1', document: {
    availableByteHash: byteHash, availableVersion: version, byteHash, bytes: bytes.length, error: RAW_TIMEOUT,
    extractor: documents.EXTRACTOR_VERSION, indexing: 'ready', pages: PAGES, stale: true, state: 'failed', truncated: false, version,
    pageStatus: pageTexts.map((p) => ({ number: p.number, status: p.status, retry: { outcome: 'failed', error: SAB_ERROR } })),
  } }];
  return { dir, version, byteHash };
}
const storedResult = (seed) => JSON.parse(fs.readFileSync(path.join(seed.dir, seed.version + '.json'), 'utf8'));
const ocrRequests = (side) => side.seen.filter((s) => s.path === '/extract');

/** Run `fn` with the fake sidecar as the OCR worker and the sync's log lines captured. */
async function withOcr(fn) {
  const side = await fakeOcr();
  const env = { OCR_BASE_URL: process.env.OCR_BASE_URL, DOCLING_BASE_URL: process.env.DOCLING_BASE_URL };
  process.env.OCR_BASE_URL = side.url; delete process.env.DOCLING_BASE_URL;
  const lines = [];
  const log = console.log, warn = console.warn;
  console.log = (...a) => { const l = a.join(' '); if (l.startsWith('[sources]')) lines.push(l); else log(...a); };
  console.warn = (...a) => { lines.push(a.join(' ')); };
  try { return await fn(side, lines); } finally {
    console.log = log; console.warn = warn;
    for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await side.close();
  }
}
const noNames = (lines) => { for (const l of lines) { assert.ok(!l.includes('synthetic-large') && !l.includes(FOLDER) && !l.includes('SYN-'), `content-free: ${l}`); } };

test('#1885 follow-up: an unchanged file whose stored result holds the SAB error is reopened once on sync and OCR\'d', { timeout: 60_000 }, async () => {
  await withOcr(async (side, lines) => {
    const h = harness({ read: async () => bytes });
    const seed = seedLiveShape(h);
    const out = await h.sync();
    assert.equal(out.status, 200);
    const requests = ocrRequests(side);
    assert.ok(requests.length >= 1, 'the reopened pages went to the OCR worker');
    assert.ok(requests.every((r) => r.hash === seed.byteHash), 'the worker got the file bytes, unchanged');
    assert.deepEqual(requests.flatMap((r) => r.pages).sort((a, b) => a - b), Array.from({ length: PAGES }, (_, i) => i + 1));
    const file = h.project.files[0];
    assert.equal(file.document.state, 'ready');
    assert.equal(file.document.stale, false);
    assert.equal(file.document.error, undefined);
    assert.equal(file.document.version, seed.version, 'same bytes, same version: the file was unchanged');
    assert.ok(file.document.pageStatus.every((p) => p.retry?.outcome === 'recovered'));
    assert.match(file.content, /SYN-OCR-2/);
    assert.equal(documents.reopenable(storedResult(seed)), false, 'stored as complete: not reopened again');
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\[sources\] sync project=[0-9a-f]{8} status=200 seen=1 ingested=1 extracted=0 reopened=1 unchanged=0 reopenedStored=0 errors=0 skipped=0 ms=\d+$/);

    // Once only: the next sync reuses the stored result and asks the worker nothing.
    const before = side.seen.length;
    assert.equal((await h.sync()).status, 200);
    assert.equal(side.seen.length, before);
    assert.match(lines[1], /status=200 seen=1 ingested=1 extracted=0 reopened=0 unchanged=1 reopenedStored=0 errors=0/);
    noNames(lines);
  });
});

test('#1885 follow-up: when the storage read times out ("Refresh failed · using previous text"), the stored original is reopened once', { timeout: 60_000 }, async () => {
  await withOcr(async (side, lines) => {
    const timeout = () => { throw Object.assign(new Error('the storage server did not answer in time'), { status: 504, code: 'timeout' }); };
    const h = harness({ read: async () => timeout() });
    const seed = seedLiveShape(h);
    const out = await h.sync();
    assert.equal(out.status, 200);
    assert.equal(h.reads(), 1);
    const requests = ocrRequests(side);
    assert.ok(requests.length >= 1, 'reopened from the stored original, through the OCR worker');
    assert.ok(requests.every((r) => r.hash === seed.byteHash));
    const file = h.project.files[0];
    assert.equal(file.document.state, 'failed', 'the refresh itself still failed');
    assert.equal(file.document.stale, true);
    assert.match(file.document.error, /did not answer in time/, 'the worded storage timeout, not the raw one');
    assert.ok(file.document.pageStatus.every((p) => p.retry?.outcome === 'recovered'), 'but the previous version is now read in full');
    assert.match(file.content, /SYN-OCR-9/);
    assert.equal(out.body.skipped.length, 1);
    assert.equal(out.body.skipped[0].code, 'storageTimeout');
    assert.equal(out.body.skipped[0].retained, true);
    assert.equal(documents.reopenable(storedResult(seed)), false);
    assert.match(lines[0], /status=200 seen=1 ingested=0 extracted=0 reopened=0 unchanged=0 reopenedStored=1 errors=1 skipped=1/);

    // Once only: another timed-out sync does not reopen it again.
    const before = side.seen.length;
    await h.sync();
    assert.equal(side.seen.length, before);
    assert.match(h.project.files[0].content, /SYN-OCR-9/, 'the recovered text is kept');
    assert.match(lines[1], /reopenedStored=0 errors=1 skipped=1/);
    noNames(lines);
  });
});

test('#1885 follow-up: a failed read with a stored result that is not reopenable keeps the previous text and does no OCR', { timeout: 60_000 }, async () => {
  await withOcr(async (side, lines) => {
    const h = harness({ read: async () => { throw Object.assign(new Error('the storage server did not answer in time'), { status: 504, code: 'timeout' }); } });
    const seed = seedLiveShape(h);
    const done = { ...storedResult(seed), state: 'ready', pageTexts: storedResult(seed).pageTexts.map((p) => ({ ...p, retry: { outcome: 'recovered', dpi: 400, attempts: 1 } })) };
    fs.writeFileSync(path.join(seed.dir, seed.version + '.json'), JSON.stringify(done));
    await h.sync();
    assert.equal(side.seen.length, 0);
    assert.equal(h.project.files[0].document.state, 'failed');
    assert.equal(h.project.files[0].content, 'SYN-NATIVE-1');
    assert.match(lines[0], /reopenedStored=0 errors=1/);
  });
});

test('#1885 follow-up: a timeout while the body is arriving is the storage timeout, worded and coded', { timeout: 30_000 }, async () => {
  const realFetch = global.fetch;
  global.fetch = async () => new Response(new ReadableStream({
    start(c) { c.enqueue(new Uint8Array(1024)); },
    pull() { throw new DOMException(RAW_TIMEOUT, 'TimeoutError'); },
  }), { headers: { 'content-length': String(4096) } });
  try {
    const conn = { kind: 'webdav', baseUrl: 'http://fixture.invalid/dav', username: 'synthetic', secret: 'synthetic' };
    await assert.rejects(storage.readBinaryFile(conn, 'synthetic.pdf', { cap: 96 * MiB }), (err) => {
      assert.equal(err.code, 'timeout'); assert.equal(err.status, 504);
      assert.equal(storage.storageFailure(err).kind, 'timeout');
      return true;
    });
  } finally { global.fetch = realFetch; }
});
