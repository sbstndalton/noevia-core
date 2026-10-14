'use strict';
// #1726: multimodal RAG — image vectors in the project index, scanned pages skipped, a text query that
// finds an image by content, the rate-limited backfill, and flag-off behaviour. Synthetic bytes and a fake
// embeddings server only (no model, no real document).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

delete process.env.RAG_DIR;
for (const k of ['EMBEDDING_BASE_URL', 'EMBEDDING_MODEL', 'EMBED_MODEL', 'EMBEDDING_PROFILE', 'EMBEDDING_NEXT_MODEL', 'EMBEDDING_NEXT_BASE_URL', 'EMBEDDING_NEXT_PROFILE', 'EMBEDDING_IMAGE_MODEL', 'NOEVIA_MULTIMODAL_RAG']) delete process.env[k];

const { createEmbeddingConfig } = require('./embedding-config.cjs');
const multimodal = require('./multimodal-rag.cjs');

let depsOk = true;
try { require('better-sqlite3'); require('sqlite-vec'); } catch { depsOk = false; }
const dbTest = depsOk ? test : test.skip;

const USER = '11111111-1111-4111-8111-111111111111';
const WORDS = ['apple', 'banana', 'cherry', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];
const vectorOf = (text) => WORDS.map((w) => (String(text).toLowerCase().split(w).length - 1) + 0.01);
// A synthetic "image": PNG magic bytes, then a word the fake embedder "sees" in it.
const pngOf = (word) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`synthetic picture of ${word} ${word} ${word}`)]);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// Fake llama.cpp embeddings router: strings are text, { content: [image_url] } entries are images (the
// b11610 multimodal input shape). Records every request.
function startServer({ refuseImages = false } = {}) {
  const seen = [];
  const srv = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    if (req.method === 'GET') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'gemma-test' }] })); return; }
    const body = JSON.parse(raw);
    seen.push(body);
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    if (refuseImages && inputs.some((i) => typeof i === 'object')) { res.statusCode = 501; res.end('{"error":"image input is not supported - hint: if this is unexpected, you may need to provide the mmproj"}'); return; }
    const data = inputs.map((input, index) => {
      if (typeof input === 'string') return { index, embedding: vectorOf(input) };
      const part = input.content[0];
      const bytes = Buffer.from(part.image_url.url.split(',')[1], 'base64');
      return { index, embedding: vectorOf(bytes.toString('latin1')) };
    });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data }));
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ seen, url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() })));
}

function freshRag() { delete require.cache[require.resolve('./rag.cjs')]; return require('./rag.cjs'); }

async function setup({ profile = 'embeddinggemma-2', refuseImages = false } = {}) {
  const server = await startServer({ refuseImages });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-1726-'));
  const config = createEmbeddingConfig({ env: { EMBEDDING_BASE_URL: server.url, EMBEDDING_MODEL: 'gemma-test', EMBEDDING_PROFILE: profile }, stateFile: path.join(dir, 'embedding-config.json') });
  const rag = freshRag();
  rag.init({ dataDir: dir, inferenceUrl: 'http://engine.invalid', embeddingConfig: config,
    userDataDirFn: (id) => path.join(dir, 'users', id), listUserIds: () => [USER], userActive: () => true });
  return { server, dir, rag, done: () => server.close() };
}

// A workspace with one project: two image sources (apple, banana) and a document whose Docling record
// has a figure on a native page (cherry) and one on a scanned page (delta).
function workspaceFixture(dir) {
  const ws = { userId: USER, dir: path.join(dir, 'ws'), assetDir: (id) => path.join(dir, 'ws', 'assets', id) };
  const docDir = path.join(dir, 'ws', 'docs');
  fs.mkdirSync(ws.assetDir('p1'), { recursive: true }); fs.mkdirSync(docDir, { recursive: true });
  const apple = pngOf('apple'), banana = pngOf('banana'), cherry = pngOf('cherry'), delta = pngOf('delta');
  fs.writeFileSync(path.join(ws.assetDir('p1'), 'img-aaa'), apple);
  fs.writeFileSync(path.join(ws.assetDir('p1'), 'img-bbb'), banana);
  const version = 'c'.repeat(64);
  fs.writeFileSync(path.join(docDir, `${version}.fig0.png`), cherry);
  fs.writeFileSync(path.join(docDir, `${version}.fig1.png`), delta);
  fs.writeFileSync(path.join(docDir, `${version}.json`), JSON.stringify({
    pageTexts: [{ number: 1, status: 'native', method: 'docling', text: 'Report text' }, { number: 2, status: 'native', method: 'docling', ocr: true, text: 'scanned words' }],
    figures: [{ page: 1, index: 0, file: `${version}.fig0.png`, hash: sha(cherry), caption: 'Orchard chart' }, { page: 2, index: 1, file: `${version}.fig1.png`, hash: sha(delta) }],
  }));
  const project = { id: 'p1', assets: [
    { id: 'img-aaa', name: 'fruit.png', mime: 'image/png', bytes: apple.length, sourceName: 'fruit.png' },
    { id: 'img-bbb', name: 'yellow.png', mime: 'image/png', bytes: banana.length, sourceName: 'yellow.png' }],
  files: [
    { name: 'fruit.png', content: '', attachment: { id: sha(apple), group: 'Images', state: 'vision' } },
    { name: 'yellow.png', content: '', attachment: { id: sha(banana), group: 'Images', state: 'vision' } },
    { name: 'report.pdf', content: '[Page 1]\nReport text', document: { availableVersion: version, version } }] };
  ws.projects = [project];
  return { ws, project, docDir, version, bytes: { apple, banana, cherry, delta } };
}

async function syncAll(rag, ws, project, docDir) {
  const items = multimodal.mediaItems(ws, project, { documentDir: () => docDir });
  let r;
  do { r = await rag.syncProjectMedia(project.id, USER, items, { limit: 1 }); } while (r.ok && r.pending > 0 && r.embedded > 0);
  return r;
}

function imageInputs(seen) {
  return seen.flatMap((b) => (Array.isArray(b.input) ? b.input : [b.input])).filter((i) => typeof i === 'object').map((i) => Buffer.from(i.content[0].image_url.url.split(',')[1], 'base64').toString('latin1'));
}

dbTest('images get an image vector, scanned pages do not', async () => {
  const s = await setup();
  try {
    const f = workspaceFixture(s.dir);
    const items = multimodal.mediaItems(f.ws, f.project, { documentDir: () => f.docDir });
    assert.deepEqual(items.map((i) => i.label).sort(), ['Figure 1 on page 1 of report.pdf: Orchard chart', 'Image fruit.png', 'Image yellow.png'].sort(), 'the figure on the scanned page is not an image item');
    const r = await syncAll(s.rag, f.ws, f.project, f.docDir);
    assert.equal(r.ok, true);
    const sent = imageInputs(s.server.seen);
    assert.equal(sent.length, 3, 'one embedding request per image');
    assert.ok(sent.some((t) => t.includes('apple')) && sent.some((t) => t.includes('banana')) && sent.some((t) => t.includes('cherry')));
    assert.ok(!sent.some((t) => t.includes('delta')), 'the scanned page is never embedded as an image');
    // Images carry no text prefix (EmbeddingGemma 2: prefixes apply to text only) and go as content parts.
    for (const b of s.server.seen) for (const i of b.input) assert.deepEqual(Object.keys(i), ['content']);
    // Same index file, same slot, same width as text; rows say what they are.
    const Database = require('better-sqlite3');
    const db = new Database(path.join(s.dir, 'users', USER, 'rag', 'p1.db'));
    require('sqlite-vec').load(db);
    const rows = db.prepare("SELECT file, meta FROM chunks WHERE kind = 'image' ORDER BY file").all();
    assert.equal(rows.length, 3);
    const fig = JSON.parse(rows.find((x) => x.file === 'report.pdf').meta);
    assert.deepEqual([fig.source, fig.page, fig.figure], ['report.pdf', 1, 1]);
    const slot = require('./vector-slots.cjs').listSlots(db)[0];
    assert.equal(slot.dim, WORDS.length);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${slot.table}`).get().n, 3);
    db.close();
    // A second pass has nothing left to embed.
    s.server.seen.length = 0;
    const again = await syncAll(s.rag, f.ws, f.project, f.docDir);
    assert.equal(again.pending, 0); assert.equal(s.server.seen.length, 0);
  } finally { s.done(); }
});

dbTest('a text query retrieves an image by its content (one query vector, text and images)', async () => {
  const s = await setup();
  try {
    const f = workspaceFixture(s.dir);
    await syncAll(s.rag, f.ws, f.project, f.docDir);
    s.server.seen.length = 0;
    const found = await s.rag.searchProjectWithImages('p1', 'which picture shows an apple', USER);
    assert.equal(s.server.seen.length, 1, 'one query embedding for text and images');
    assert.deepEqual(s.server.seen[0].input, ['task: search result | query: which picture shows an apple']);
    assert.equal(found.images[0].file, 'fruit.png');
    assert.equal(found.images[0].meta.assetId, 'img-aaa');
    assert.ok(!found.images.some((h) => h.file === 'yellow.png'), 'the banana image does not match an apple question');
    assert.equal(found.indexed.length, 3);
    // The plain text search never returns image rows (other callers read `body` as text).
    assert.deepEqual(await s.rag.searchProject('p1', 'apple', USER), []);
    // filesContext hands image hits to the caller and never puts image content into the prompt text.
    let got = null;
    const text = await s.rag.filesContext('p1', f.project.files, 'which picture shows an apple', USER, null, { images: true, onImages: (x) => { got = x; } });
    assert.equal(got.hits[0].file, 'fruit.png');
    assert.ok(!/synthetic picture/.test(text));
  } finally { s.done(); }
});

dbTest('image rows stay out of text re-indexing and survive a text re-index; deleting the source removes them', async () => {
  const s = await setup();
  try {
    const f = workspaceFixture(s.dir);
    await syncAll(s.rag, f.ws, f.project, f.docDir);
    const long = 'cherry orchard notes. '.repeat(200);
    await s.rag.indexProjectFile('p1', 'report.pdf', long, USER);
    const textInputs = s.server.seen.flatMap((b) => b.input).filter((i) => typeof i === 'string');
    assert.ok(!textInputs.some((t) => /Figure 1 on page/.test(t)), 'an image label is never embedded as text');
    const cov = s.rag.indexCoverage({ projectId: 'p1', userId: USER }, s.rag.embeddingConfig().active());
    assert.equal(cov.chunks, cov.vectors, 'coverage counts text chunks only');
    const hits = (await s.rag.searchProjectWithImages('p1', 'cherry', USER)).images;
    assert.ok(hits.some((h) => h.file === 'report.pdf'), 'the figure kept its vector through the text re-index');
    // A text-less source re-indexed (indexSource) keeps its image vector...
    s.rag.deleteProjectFile('p1', 'fruit.png', USER, { keepMedia: true });
    assert.ok((await s.rag.searchProjectWithImages('p1', 'apple', USER)).images.some((h) => h.file === 'fruit.png'));
    // ...removing the source removes it.
    s.rag.deleteProjectFile('p1', 'fruit.png', USER);
    assert.ok(!(await s.rag.searchProjectWithImages('p1', 'apple', USER)).images.some((h) => h.file === 'fruit.png'));
  } finally { s.done(); }
});

dbTest('a changed or removed image is reconciled, and its cached caption goes with it', async () => {
  const s = await setup();
  try {
    const f = workspaceFixture(s.dir);
    await syncAll(s.rag, f.ws, f.project, f.docDir);
    const oldHash = `img:${sha(f.bytes.apple)}`;
    assert.equal(s.rag.writeCaption('p1', USER, oldHash, 'A red apple.', 'vision-test'), true);
    assert.equal(s.rag.writeCaption('p1', USER, `img:${'0'.repeat(64)}`, 'not an image here', 'x'), false, 'only an image this index holds');
    assert.deepEqual(s.rag.readCaption('p1', USER, oldHash), { caption: 'A red apple.', model: 'vision-test' });
    // The source now holds other bytes (a new upload under the same name).
    const replaced = pngOf('golf');
    fs.writeFileSync(path.join(f.ws.assetDir('p1'), 'img-aaa'), replaced);
    f.project.files[0].attachment.id = sha(replaced);
    s.server.seen.length = 0;
    await syncAll(s.rag, f.ws, f.project, f.docDir);
    assert.deepEqual(imageInputs(s.server.seen).map((t) => t.includes('golf')), [true], 'only the changed image is embedded again');
    assert.equal(s.rag.readCaption('p1', USER, oldHash), null, 'the old caption is gone with the old image');
    assert.equal((await s.rag.searchProjectWithImages('p1', 'golf', USER)).images[0].file, 'fruit.png');
  } finally { s.done(); }
});

dbTest('no image projector: nothing is stored as a vector, the backlog stays pending, text search is unaffected', async () => {
  const s = await setup({ refuseImages: true });
  try {
    const f = workspaceFixture(s.dir);
    const r = await syncAll(s.rag, f.ws, f.project, f.docDir);
    assert.equal(r.ok, false); assert.equal(r.reason, 'embed-failed'); assert.equal(r.pending, 3);
    assert.deepEqual((await s.rag.searchProjectWithImages('p1', 'apple', USER)).images, []);
  } finally { s.done(); }
});

dbTest('a profile without image support never embeds images', async () => {
  const s = await setup({ profile: 'nomic-v1' });
  try {
    const f = workspaceFixture(s.dir);
    const r = await syncAll(s.rag, f.ws, f.project, f.docDir);
    assert.equal(r.reason, 'profile-has-no-images');
    assert.equal(s.server.seen.length, 0);
  } finally { s.done(); }
});

test('the backfill is rate-limited: one image per request, a pause between requests', async () => {
  const calls = [], sleeps = [];
  let pending = 4;
  const rag = { syncProjectMedia: async (projectId, userId, items, opts) => {
    calls.push({ projectId, userId, limit: opts.limit, at: sleeps.length });
    if (!pending) return { ok: true, embedded: 0, pending: 0 };
    pending -= 1;
    return { ok: true, embedded: 1, pending };
  } };
  const ws = { projects: [{ id: 'p1', files: [], assets: [] }], assetDir: () => '/synthetic-only' };
  const backfill = multimodal.createMediaBackfill({ enabled: () => true, userIds: () => [USER], workspaceFor: () => ws, documentDir: () => '/synthetic-only', rag,
    sleep: async (ms) => { sleeps.push(ms); }, log: () => {}, env: { NOEVIA_MULTIMODAL_RAG_INTERVAL_MS: '1500' } });
  await backfill.kick();
  assert.ok(calls.every((c) => c.limit === 1), 'one image per request');
  assert.equal(calls.filter((c, i) => i < 4).length, 4);
  assert.deepEqual(sleeps, [1500, 1500, 1500], 'a pause after every embedded image that leaves more to do');
  // Each request after the first comes after a pause.
  for (let i = 1; i < 4; i++) assert.equal(calls[i].at, i);
});

test('a failed backfill pauses and retries later instead of hammering the server', async () => {
  let n = 0;
  const timers = [];
  const rag = { syncProjectMedia: async () => { n += 1; return { ok: false, reason: 'embed-failed', error: 'HTTP 501', embedded: 0, pending: 3 }; } };
  const backfill = multimodal.createMediaBackfill({ enabled: () => true, userIds: () => [USER], workspaceFor: () => ({ projects: [{ id: 'a' }, { id: 'b' }], assetDir: () => '/x' }),
    documentDir: () => '/x', rag, sleep: async () => {}, log: () => {}, env: { NOEVIA_MULTIMODAL_RAG_RETRY_MS: '60000' }, setTimer: (fn, ms) => { timers.push(ms); return 1; }, clearTimer: () => {} });
  await backfill.kick();
  assert.equal(n, 1, 'the pass stops at the first failure');
  assert.deepEqual(timers, [60000]);
});

test('flag off: the backfill never runs and the extractor version is unchanged', async () => {
  assert.equal(multimodal.enabled({}), false);
  assert.equal(multimodal.enabled({ NOEVIA_MULTIMODAL_RAG: '0' }), false);
  assert.equal(multimodal.enabled({ NOEVIA_MULTIMODAL_RAG: '1' }), true);
  let called = 0;
  const backfill = multimodal.createMediaBackfill({ enabled: () => false, userIds: () => [USER], workspaceFor: () => ({ projects: [{ id: 'p' }] }), documentDir: () => '/x',
    rag: { syncProjectMedia: async () => { called += 1; return { ok: true }; } }, sleep: async () => {}, log: () => {} });
  assert.equal(backfill.kick(), null); assert.equal(backfill.schedule(USER, 'p'), null);
  assert.equal(called, 0);
  delete require.cache[require.resolve('./documents.cjs')];
  const before = process.env.DOCLING_BASE_URL;
  process.env.DOCLING_BASE_URL = 'http://docling.invalid';
  try {
    assert.equal(require('./documents.cjs').EXTRACTOR_VERSION, `docling-pages-v1:${require('./docling.cjs').VERSION}`);
  } finally {
    if (before === undefined) delete process.env.DOCLING_BASE_URL; else process.env.DOCLING_BASE_URL = before;
    delete require.cache[require.resolve('./documents.cjs')];
  }
});

dbTest('flag off: stored image vectors are ignored (not deleted) and filesContext searches text only', async () => {
  const s = await setup();
  try {
    const f = workspaceFixture(s.dir);
    await syncAll(s.rag, f.ws, f.project, f.docDir);
    s.server.seen.length = 0;
    // A project with only small files and images: off, no search runs at all, as before #1726.
    const text = await s.rag.filesContext('p1', f.project.files.slice(0, 2), 'apple', USER, null, { attached: false });
    assert.equal(s.server.seen.length, 0);
    assert.ok(!/synthetic picture/.test(text));
    const Database = require('better-sqlite3');
    const db = new Database(path.join(s.dir, 'users', USER, 'rag', 'p1.db'));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE kind = 'image'").get().n, 3, 'nothing was deleted');
    db.close();
  } finally { s.done(); }
});

test('Docling figures: requested only when on, checked, and never kept from a scanned page', async () => {
  const documents = require('./documents.cjs');
  const png = pngOf('echo');
  const seen = [];
  const extractDocument = async (name, bytes, opts) => {
    seen.push(opts);
    return { total: 2, pages: [{ number: 1, text: 'Native page', status: 'native', method: 'docling', ocr: false }, { number: 2, text: 'OCR words', status: 'native', method: 'docling', ocr: true }],
      figures: [{ page: 1, index: 0, mime: 'image/png', data: png.toString('base64'), caption: 'Echo chart' },
        { page: 2, index: 1, mime: 'image/png', data: png.toString('base64') },
        { page: 1, index: 2, mime: 'image/png', data: Buffer.from('not a png').toString('base64') },
        { page: 9, index: 3, mime: 'image/png', data: png.toString('base64') }] };
  };
  const on = await documents.extractDocumentText('report.pdf', Buffer.from('%PDF'), { doclingEnabled: true, extractDocument, figures: true });
  assert.deepEqual(seen[0], { figures: true });
  assert.deepEqual(on.figures.map((x) => [x.page, x.index, x.caption]), [[1, 0, 'Echo chart']], 'scanned page, wrong bytes and an unknown page are dropped');
  assert.equal(on.pageTexts[1].ocr, true, 'the scanned-page marker is kept');
  const off = await documents.extractDocumentText('report.pdf', Buffer.from('%PDF'), { doclingEnabled: true, extractDocument, figures: false });
  assert.equal(seen.length, 2); assert.equal(seen[1], undefined, 'off: the worker is called exactly as before');
  assert.equal('figures' in off, false); assert.equal('ocr' in off.pageTexts[1], false);
});

test('the native OCR pass marks its pages as scanned', () => {
  assert.equal(multimodal.scannedPage({ status: 'ocr', method: 'native+ocr' }), true);
  assert.equal(multimodal.scannedPage({ status: 'truncated', method: 'native+ocr' }), true);
  assert.equal(multimodal.scannedPage({ status: 'native', method: 'docling', ocr: true }), true);
  assert.equal(multimodal.scannedPage({ status: 'native', method: 'docling' }), false);
});

test('Docling worker request carries the figures header only when asked', async () => {
  const docling = require('./docling.cjs');
  const headers = [];
  const fetchImpl = async (url, init) => { headers.push(init.headers); return new Response(JSON.stringify({ pages: [] }), { status: 200 }); };
  await docling.extractDocument('a.pdf', Buffer.from('x'), { url: 'http://docling.invalid', fetchImpl });
  await docling.extractDocument('a.pdf', Buffer.from('x'), { url: 'http://docling.invalid', fetchImpl, figures: true });
  assert.equal('X-Document-Figures' in headers[0], false);
  assert.equal(headers[1]['X-Document-Figures'], '1');
});

test('document figures are stored as files beside their version and survive a prune', async () => {
  delete require.cache[require.resolve('./document-sources.cjs')];
  const documents = require('./documents.cjs');
  const sources = require('./document-sources.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-1726-'));
  const ws = { dir };
  const png = pngOf('foxtrot');
  const original = documents.extractDocumentText;
  documents.extractDocumentText = async () => ({ text: '[Page 1]\nx', pages: 1, pageTexts: [{ number: 1, text: 'x', status: 'native' }], state: 'ready', truncated: false,
    figures: [{ page: 1, index: 0, mime: 'image/png', ext: 'png', bytes: png, caption: 'Foxtrot' }] });
  try {
    const file = await sources.ingest(ws, 'p1', 'report.pdf', Buffer.from('%PDF synthetic'), null);
    const version = file.document.version;
    const record = JSON.parse(fs.readFileSync(path.join(sources.directory(ws, 'p1'), `${version}.json`), 'utf8'));
    assert.deepEqual(record.figures, [{ page: 1, index: 0, file: `${version}.fig0.png`, hash: sha(png), caption: 'Foxtrot' }]);
    assert.deepEqual(fs.readFileSync(path.join(sources.directory(ws, 'p1'), `${version}.fig0.png`)), png);
    sources.prune(ws, { id: 'p1', files: [file] });
    assert.ok(fs.existsSync(path.join(sources.directory(ws, 'p1'), `${version}.fig0.png`)), 'a kept version keeps its figures');
    sources.prune(ws, { id: 'p1', files: [] });
    assert.ok(!fs.existsSync(path.join(sources.directory(ws, 'p1'), `${version}.fig0.png`)), 'and loses them with it');
  } finally { documents.extractDocumentText = original; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a caption is generated once, also when two answers ask at the same time', async () => {
  let generated = 0;
  const store = new Map();
  const deps = { read: () => store.get('k') || null, write: (caption, model) => store.set('k', { caption, model }),
    generate: async () => { generated += 1; await new Promise((r) => setTimeout(r, 10)); return { caption: 'A synthetic chart.', model: 'vision-test' }; } };
  const [a, b] = await Promise.all([multimodal.captionOnce('k', deps), multimodal.captionOnce('k', deps)]);
  const c = await multimodal.captionOnce('k', deps);
  assert.equal(generated, 1);
  for (const x of [a, b, c]) assert.equal(x.caption, 'A synthetic chart.');
});

test('the backfill waits while a re-index is under way, and releases the image preset after embedding', async () => {
  let calls = 0, released = 0;
  const rag = { syncProjectMedia: async () => { calls += 1; return calls === 1 ? { ok: true, embedded: 1, pending: 0 } : { ok: true, embedded: 0, pending: 0 }; } };
  const ws = { projects: [{ id: 'p1' }], assetDir: () => '/x' };
  const held = multimodal.createMediaBackfill({ enabled: () => true, userIds: () => [USER], workspaceFor: () => ws, documentDir: () => '/x', rag,
    paused: () => 'a re-index is under way', release: async () => { released += 1; }, sleep: async () => {}, log: () => {}, setTimer: () => 1, clearTimer: () => {} });
  await held.kick();
  assert.equal(calls, 0, 'no image is embedded while the router holds two text models');
  const free = multimodal.createMediaBackfill({ enabled: () => true, userIds: () => [USER], workspaceFor: () => ws, documentDir: () => '/x', rag,
    release: async () => { released += 1; }, sleep: async () => {}, log: () => {} });
  await free.kick();
  assert.equal(calls, 1); assert.equal(released, 1);
});
