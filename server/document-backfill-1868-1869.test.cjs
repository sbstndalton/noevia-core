'use strict';
// #1868: the text of a long document past its 200,000-character head is appended to the search index in
// budgeted, paced batches (document-backfill.cjs + rag.cjs appendFileTail), without re-indexing anything.
// #1869: uploads made with no storage connection get the #1864/#1865 completion pass once, bounded.
// Synthetic documents only; the embeddings server is a local fake that turns keyword counts into vectors.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

delete process.env.RAG_DIR;
for (const k of ['EMBEDDING_BASE_URL', 'EMBEDDING_MODEL', 'EMBED_MODEL', 'EMBEDDING_PROFILE', 'EMBEDDING_NEXT_MODEL', 'EMBEDDING_NEXT_BASE_URL', 'EMBEDDING_NEXT_PROFILE']) delete process.env[k];

const backfill = require('./document-backfill.cjs');
const documents = require('./documents.cjs');
const { createEmbeddingConfig } = require('./embedding-config.cjs');

let depsOk = true;
try { require('better-sqlite3'); require('sqlite-vec'); } catch { depsOk = false; }
const dbTest = depsOk ? test : test.skip;

const USER = '33333333-3333-4333-8333-333333333333';
const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];
const vectorFor = (text) => { const t = String(text).toLowerCase(); return WORDS.map((w) => (t.split(w).length - 1) + 0.01); };

// The embeddings endpoint, faked at rag.cjs's fetch seam: nothing leaves the process.
function fakeEmbedder() {
  const seen = [];
  const state = { fail: false };
  const fetch = async (url, init = {}) => {
    if (!String(url).endsWith('/v1/embeddings')) return new Response(JSON.stringify({ data: [{ id: 'fake-embed' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const body = JSON.parse(init.body);
    seen.push(body.input);
    if (state.fail) return new Response('{"error":"busy"}', { status: 503 });
    return new Response(JSON.stringify({ data: body.input.map((text, index) => ({ index, embedding: vectorFor(text) })) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { seen, state, fetch, url: 'http://embed.invalid/v1', close: () => {} };
}

function freshRag() { delete require.cache[require.resolve('./rag.cjs')]; return require('./rag.cjs'); }

// A synthetic page of ~2,900 characters (several chunks): sentences of filler words, plus `word` when given.
function pageText(n, word = 'alpha') {
  const sentence = `Synthetic page ${n} line about ${word} and nothing else of note.`;
  return Array.from({ length: 45 }, () => sentence).join(' ');
}
/** A long record as the page store holds it, and the source text (its first EXTRACT_CAP characters). */
function longDocument({ pages = 90, word = (n) => (n > 75 ? 'bravo' : 'alpha'), needle = 0 } = {}) {
  const pageTexts = Array.from({ length: pages }, (_, i) => ({ number: i + 1, status: 'native', method: 'native', text: pageText(i + 1, i + 1 === needle ? 'charlie charlie charlie' : word(i + 1)) }));
  const record = { pages, pageTexts, state: 'partial', truncated: true, completion: documents.COMPLETION };
  const full = backfill.fullText(record);
  record.text = full.slice(0, documents.EXTRACT_CAP);
  return { record, content: record.text, full };
}

async function setup() {
  const server = fakeEmbedder();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-1868-'));
  const config = createEmbeddingConfig({ env: { EMBEDDING_BASE_URL: server.url, EMBEDDING_MODEL: 'fake-embed', EMBEDDING_PROFILE: '' }, stateFile: path.join(dir, 'embedding-config.json') });
  const rag = freshRag();
  rag.init({ dataDir: dir, inferenceUrl: 'http://engine.invalid', embeddingConfig: config, userDataDirFn: (id) => path.join(dir, 'users', id), listUserIds: () => [USER], userActive: () => true });
  rag._test.setRagFetch(server.fetch);
  return { server, dir, rag, config, done: () => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
function openDb(dir, project) {
  const Database = require('better-sqlite3');
  const db = new Database(path.join(dir, 'users', USER, 'rag', `${project}.db`));
  require('sqlite-vec').load(db);
  return db;
}
const rowsOf = (dir, project) => { const db = openDb(dir, project); try { return db.prepare('SELECT id, file, chunk_no, body, content_hash, version, direct, kind, meta FROM chunks ORDER BY id').all(); } finally { db.close(); } };
const vectorsOf = (dir, project) => { const db = openDb(dir, project); try { return db.prepare('SELECT chunk_id, embedding FROM vec_items ORDER BY chunk_id').all().map((r) => [r.chunk_id, Buffer.from(r.embedding).toString('hex')]); } finally { db.close(); } };

/** A workspace with one project holding `files` and their records in its document directory. */
function workspaceWith(dir, files, records) {
  const project = { id: 'p-long', files };
  const saves = [];
  const workspace = { userId: USER, dir: path.join(dir, 'ws'), projects: [project], saveProjects: () => saves.push(Date.now()) };
  const docDir = path.join(dir, 'docs');
  fs.mkdirSync(docDir, { recursive: true });
  for (const [version, record] of Object.entries(records)) fs.writeFileSync(path.join(docDir, `${version}.json`), JSON.stringify(record));
  return { project, workspace, saves, documentDir: () => docDir };
}
const V1 = 'a'.repeat(64), V2 = 'b'.repeat(64), BH = 'c'.repeat(64);
const docFile = (name, content, extra = {}) => ({ name, content, document: { version: V1, availableVersion: V1, byteHash: BH, extractor: documents.EXTRACTOR_VERSION, state: 'partial', pages: 90, indexing: 'ready', ...extra } });

function makeBackfill(s, ws, env = {}, extra = {}) {
  let clock = 1_000_000;
  const pauses = [];
  const b = backfill.createDocumentBackfill({
    rag: s.rag, userIds: () => [USER], workspaceFor: () => ws.workspace, runAs: (_u, fn) => fn(), documentDir: ws.documentDir,
    completeUpload: async () => ({ status: 'complete' }), env: { PROJECT_BACKFILL_MIN_PAUSE_MS: '0', ...env },
    sleep: async (ms) => { pauses.push(ms); }, now: () => clock, log: () => {}, ...extra,
  });
  return { b, pauses, advance: (ms) => { clock += ms; } };
}

test('fullText reproduces the source text documents.cjs assembles, so the tail starts exactly where the head ends', async () => {
  const pages = 260;
  const readPages = async (_bytes, { firstPage = 1, pageCap }) => ({ numPages: pages,
    pageTexts: Array.from({ length: Math.max(0, Math.min(pages, firstPage + pageCap - 1) - firstPage + 1) }, (_, i) => ({ number: firstPage + i, status: 'native', method: 'native', text: pageText(firstPage + i) })) });
  const out = await documents.extractDocumentText('long.pdf', Buffer.from('%PDF-1.4 synthetic'), { doclingEnabled: false, ocrEnabled: false, readPages, waits: [0, 0], env: {} });
  assert.equal(out.text.length, documents.EXTRACT_CAP);
  const full = backfill.fullText(out);
  assert.ok(full.length > documents.EXTRACT_CAP);
  assert.equal(full.slice(0, documents.EXTRACT_CAP), out.text);
  const plan = backfill.tailChunks(out.text, out, { textLimit: 8_000_000, chunkText: freshRag().chunkText });
  assert.ok(plan.chunks.length > 0);
  const lastHeadPage = Number(/\[Page (\d+)\]\n[^[]*$/.exec(out.text)[1]);
  assert.equal(plan.chunks[0].page, lastHeadPage, 'the page the head is cut in is chunked again in full');
  assert.equal(plan.chunks[plan.chunks.length - 1].page, pages);
  assert.equal(backfill.tailChunks('[Page 1]\nother text', out, { textLimit: 8_000_000, chunkText: freshRag().chunkText }), null, 'another text: nothing is appended');
  const capped = backfill.tailChunks(out.text, out, { textLimit: documents.EXTRACT_CAP + 5000, chunkText: freshRag().chunkText });
  assert.equal(capped.limited, true, 'the per-document ceiling cuts the tail');
  assert.ok(capped.chunks[capped.chunks.length - 1].page < pages);
});

dbTest('#1868: the text past 200,000 characters becomes searchable, with no duplicate chunks', async () => {
  const s = await setup();
  try {
    const { record, content } = longDocument({ needle: 85 });
    const r0 = await s.rag.indexProjectFile('p-long', 'long.pdf', content, USER);
    assert.equal(r0.embedded, r0.stored);
    const before = await s.rag.searchProject('p-long', 'charlie', USER);
    assert.ok(!before.some((h) => h.body.includes('charlie')), 'page 85 is past the head: not searchable before');

    const plan = backfill.tailChunks(content, record, { textLimit: 8_000_000, chunkText: s.rag.chunkText });
    let r, calls = 0;
    do { r = await s.rag.appendFileTail('p-long', 'long.pdf', content, plan.chunks, USER, { limit: 16 }); calls += 1; } while (!r.complete && calls < 50);
    assert.equal(r.complete, true);
    const hits = await s.rag.searchProject('p-long', 'charlie', USER);
    assert.ok(hits[0].body.startsWith('[Page 85]') && hits[0].body.includes('charlie'), hits[0]?.body.slice(0, 40));

    const rows = rowsOf(s.dir, 'p-long');
    const hashes = rows.map((x) => x.content_hash);
    assert.equal(new Set(hashes).size, hashes.length, 'no chunk is stored twice');
    const tail = rows.filter((x) => x.meta && x.meta.startsWith('{"tail":1,'));
    const head = rows.filter((x) => !x.meta);
    assert.equal(head.length, r0.stored, 'the head rows are untouched');
    assert.ok(tail.every((x) => x.version === head[0].version), 'tail rows carry the head version');
    assert.ok(tail.length < plan.chunks.length, 'chunks the head already had were skipped');
    assert.equal(vectorsOf(s.dir, 'p-long').length, rows.length, 'every chunk has a vector');

    // Again: nothing new is cut or embedded.
    const seen = s.server.seen.length;
    const again = await s.rag.appendFileTail('p-long', 'long.pdf', content, plan.chunks, USER, { limit: 16 });
    assert.equal(again.inserted, 0); assert.equal(again.embedded, 0); assert.equal(again.complete, true);
    assert.equal(s.server.seen.length, seen);

    // A re-index of the same text keeps the tail; new text drops it.
    await s.rag.indexProjectFile('p-long', 'long.pdf', content, USER);
    assert.equal(rowsOf(s.dir, 'p-long').filter((x) => x.meta).length, tail.length, 're-index of the same text keeps the tail');
    const changed = content.replace('Synthetic page 1 ', 'Synthetic page one ');
    await s.rag.indexProjectFile('p-long', 'long.pdf', changed, USER);
    assert.equal(rowsOf(s.dir, 'p-long').filter((x) => x.meta).length, 0, 'a new version drops the old tail');
    const refused = await s.rag.appendFileTail('p-long', 'long.pdf', content, plan.chunks, USER, { limit: 16 });
    assert.ok(['reindex-pending', 'head-not-indexed'].includes(refused.reason), refused.reason);
    assert.equal(refused.inserted, 0, 'a tail never joins another version of the head');
    assert.equal(rowsOf(s.dir, 'p-long').filter((x) => x.meta).length, 0);
  } finally { s.done(); }
});

dbTest('#1868: the budget defers the rest of a document, and later passes resume it until it is complete', async () => {
  const s = await setup();
  try {
    const { record, content } = longDocument({ needle: 88 });
    await s.rag.indexProjectFile('p-long', 'long.pdf', content, USER);
    const file = docFile('long.pdf', content);
    const ws = workspaceWith(s.dir, [file], { [V1]: record });
    const f = makeBackfill(s, ws, { PROJECT_TAIL_EMBED_PER_PASS: '10', PROJECT_TAIL_EMBED_PER_DOCUMENT: '10', PROJECT_TAIL_EMBED_PER_HOUR: '25', PROJECT_TAIL_EMBED_BATCH: '4' });

    const t1 = await f.b.kick();
    assert.equal(t1.embedded, 10, 'one pass embeds at most its budget');
    assert.equal(t1.remaining, 1);
    assert.equal(file.document.searchable.complete, false);
    const page1 = file.document.searchable.page;
    assert.ok(page1 >= 60 && page1 < 90, `searchable up to page ${page1}`);
    const { notes, noteText } = require('./document-sources.cjs');
    const note = notes(file).find((n) => n.id === 'searchableToPage');
    assert.deepEqual(note, { id: 'searchableToPage', params: { page: page1 } });
    assert.match(noteText(note), new RegExp(`searchable up to page ${page1} so far`));
    assert.ok(f.pauses.length >= 2, 'paced between calls');
    assert.ok(!(await s.rag.searchProject('p-long', 'charlie', USER)).some((h) => h.body.includes('charlie')), 'page 88 not yet');

    assert.equal((await f.b.kick()).embedded, 10);
    assert.equal((await f.b.kick()).embedded, 5, 'the hourly budget is spent');
    assert.equal((await f.b.kick()).embedded, 0, 'held until the hour has passed');
    assert.ok(file.document.searchable.page > page1, 'coverage grows');

    let rounds = 0;
    while (!file.document.searchable?.complete && rounds++ < 40) { f.advance(3600_000); await f.b.kick(); }
    assert.equal(file.document.searchable.complete, true);
    assert.equal(file.document.searchable.page, null);
    assert.equal(notes(file).some((n) => n.id === 'searchableToPage'), false);
    const hits = await s.rag.searchProject('p-long', 'charlie', USER);
    assert.ok(hits[0].body.startsWith('[Page 88]'));
    const hashes = rowsOf(s.dir, 'p-long').map((x) => x.content_hash);
    assert.equal(new Set(hashes).size, hashes.length, 'no duplicates across passes');

    const seen = s.server.seen.length;
    f.advance(3600_000);
    const t = await f.b.kick();
    assert.equal(t.documents, 0, 'a complete document is not looked at again');
    assert.equal(s.server.seen.length, seen);
  } finally { s.done(); }
});

dbTest('#1868: an embedding failure ends the pass; the appended chunks are embedded first next time', async () => {
  const s = await setup();
  try {
    const { record, content } = longDocument();
    await s.rag.indexProjectFile('p-long', 'long.pdf', content, USER);
    const file = docFile('long.pdf', content);
    const ws = workspaceWith(s.dir, [file], { [V1]: record });
    const f = makeBackfill(s, ws, { PROJECT_TAIL_EMBED_PER_PASS: '8', PROJECT_TAIL_EMBED_BATCH: '8' });
    s.server.state.fail = true;
    const t = await f.b.kick();
    assert.match(String(t.reason), /embedding unavailable/);
    const pending = rowsOf(s.dir, 'p-long').filter((x) => x.meta);
    assert.equal(pending.length, 8, 'rows stored, vectors pending');
    s.server.state.fail = false;
    const t2 = await f.b.kick();
    assert.equal(t2.embedded, 8);
    const after = rowsOf(s.dir, 'p-long').filter((x) => x.meta);
    assert.deepEqual(after.map((x) => x.id), pending.map((x) => x.id), 'the same rows got their vectors; none were added twice');
  } finally { s.done(); }
});

dbTest('#1868: held while a re-index is under way', async () => {
  const s = await setup();
  try {
    const { record, content } = longDocument();
    await s.rag.indexProjectFile('p-long', 'long.pdf', content, USER);
    const ws = workspaceWith(s.dir, [docFile('long.pdf', content)], { [V1]: record });
    const seen = s.server.seen.length;
    const f = makeBackfill(s, ws, {}, { paused: () => 'a re-index is under way' });
    const t = await f.b.kick();
    assert.equal(t.reason, 'a re-index is under way');
    assert.equal(t.embedded, 0);
    assert.equal(s.server.seen.length, seen);
  } finally { s.done(); }
});

dbTest('#1868: short documents are byte-identical in the index after a pass', async () => {
  const s = await setup();
  try {
    const short = Array.from({ length: 5 }, (_, i) => `[Page ${i + 1}]\n${pageText(i + 1, 'delta')}`).join('\n\n');
    const tiny = '[Page 1]\nA two-line synthetic note about echo.';
    await s.rag.indexProjectFile('p-long', 'short.pdf', short, USER);
    await s.rag.indexProjectFile('p-long', 'tiny.pdf', tiny, USER);
    const rows = rowsOf(s.dir, 'p-long');
    const vectors = vectorsOf(s.dir, 'p-long');
    const records = {
      [V1]: { pages: 5, pageTexts: Array.from({ length: 5 }, (_, i) => ({ number: i + 1, status: 'native', text: pageText(i + 1, 'delta') })), text: short },
      [V2]: { pages: 1, pageTexts: [{ number: 1, status: 'native', text: 'A two-line synthetic note about echo.' }], text: tiny },
    };
    const ws = workspaceWith(s.dir, [docFile('short.pdf', short), docFile('tiny.pdf', tiny, { version: V2, availableVersion: V2, indexing: 'direct' })], records);
    const seen = s.server.seen.length;
    const f = makeBackfill(s, ws);
    const t = await f.b.kick();
    assert.equal(t.documents, 0, 'neither is a candidate');
    assert.deepEqual(rowsOf(s.dir, 'p-long'), rows);
    assert.deepEqual(vectorsOf(s.dir, 'p-long'), vectors);
    assert.equal(s.server.seen.length, seen, 'no embedding request');
    // Even asked directly, a short document gains nothing.
    const plan = backfill.tailChunks(short, records[V1], { textLimit: 8_000_000, chunkText: s.rag.chunkText });
    assert.deepEqual(plan.chunks, []);
    // And re-indexing it is exactly what it was (the tail-keeping drop leaves it as before).
    await s.rag.indexProjectFile('p-long', 'short.pdf', short, USER);
    assert.deepEqual(rowsOf(s.dir, 'p-long').map(({ id, ...r }) => r).filter((r) => r.file === 'short.pdf'), rows.map(({ id, ...r }) => r).filter((r) => r.file === 'short.pdf'));
  } finally { s.done(); }
});

// ── #1869 ────────────────────────────────────────────────────────────────────────────────────────

test('#1869: candidates are uploads with no storage source, read by the current extractor, not yet finished', () => {
  const ex = documents.EXTRACTOR_VERSION;
  const base = docFile('u.pdf', 'x');
  assert.equal(backfill.uploadCandidate(base, ex), true);
  assert.equal(backfill.uploadCandidate({ ...base, source: 'Folder' }, ex), false, 'a synced folder gets the pass on sync');
  assert.equal(backfill.uploadCandidate({ ...base, name: 'u.docx' }, ex), false);
  assert.equal(backfill.uploadCandidate({ ...base, document: { ...base.document, extractor: 'other' } }, ex), false);
  assert.equal(backfill.uploadCandidate({ ...base, document: { ...base.document, completionSweep: V1 } }, ex), false);
});

test('#1869: the pass is bounded per run, shares one OCR budget, resumes, and stops once every upload is finished', async () => {
  const files = Array.from({ length: 5 }, (_, i) => docFile(`u${i}.pdf`, '[Page 1]\nshort', { indexing: 'direct' }));
  const project = { id: 'p-up', files };
  const workspace = { userId: USER, projects: [project], saveProjects: () => {} };
  const calls = [];
  const budgets = new Set();
  const left = new Map(files.map((f) => [f.name, f.name === 'u0.pdf' ? 2 : 1])); // u0 needs two passes
  const completeUpload = async (_p, file, { ocrBudget }) => {
    calls.push(file.name); budgets.add(ocrBudget);
    assert.equal(ocrBudget.remaining <= 40, true);
    ocrBudget.remaining -= 15;
    const n = left.get(file.name) - 1; left.set(file.name, n);
    if (n > 0) return { status: 'deferred' };
    file.document.completionSweep = file.document.version;
    return { status: 'completed' };
  };
  const b = backfill.createDocumentBackfill({ rag: {}, userIds: () => [USER], workspaceFor: () => workspace, runAs: (_u, fn) => fn(), documentDir: () => '/nonexistent',
    completeUpload, env: { PROJECT_BACKFILL_MIN_PAUSE_MS: '0' }, sleep: async () => {}, log: () => {} });
  assert.equal(b.settings.uploads, 2);
  const t1 = await b.kick();
  assert.deepEqual(calls, ['u0.pdf', 'u1.pdf'], 'two documents per pass');
  assert.equal(t1.remaining, 3);
  assert.equal(budgets.size, 1, 'one OCR budget for the whole pass');
  assert.equal([...budgets][0].remaining, 40 - 30, 'the sync path budget (40 pages), spent across documents');
  let passes = 1;
  while (files.some((f) => f.document.completionSweep !== f.document.version) && passes < 10) { await b.kick(); passes += 1; }
  assert.equal(passes, 3, 'two per pass: u0+u1, u0 (resumed)+u2, u3+u4');
  assert.equal(calls.length, 6, 'u0 twice (resumed), the others once');
  const before = calls.length;
  await b.kick(); await b.kick();
  assert.equal(calls.length, before, 'once finished, never again');
  b.stop();
});

test('#1869: an unreachable extraction service ends the uploads for this pass', async () => {
  const files = Array.from({ length: 3 }, (_, i) => docFile(`u${i}.pdf`, '[Page 1]\nshort', { indexing: 'direct' }));
  const workspace = { userId: USER, projects: [{ id: 'p-up', files }], saveProjects: () => {} };
  const calls = [];
  const b = backfill.createDocumentBackfill({ rag: {}, userIds: () => [USER], workspaceFor: () => workspace, runAs: (_u, fn) => fn(), documentDir: () => '/nonexistent',
    completeUpload: async (_p, file) => { calls.push(file.name); return { status: 'retry', unreachable: true }; },
    env: { PROJECT_BACKFILL_MIN_PAUSE_MS: '0', PROJECT_UPLOAD_COMPLETION_PER_PASS: '5' }, sleep: async () => {}, log: () => {} });
  const t = await b.kick();
  assert.deepEqual(calls, ['u0.pdf']);
  assert.equal(t.remaining, 2);
});

test('#1869: completeUploadedDocument runs the stored record\'s completion once, within the budget, and marks it finished', async () => {
  const documentSources = require('./document-sources.cjs');
  const realComplete = documents.completeDocument;
  const realExtract = documents.extractDocumentText;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-1869-'));
  const project = { id: 'proj-up', files: [] };
  const workspace = { assetDir: (id) => path.join(dir, 'assets', id), dir: path.join(dir, 'ws'), userId: USER, projects: [project], saveProjects: () => {} };
  const indexed = [];
  const store = require('./projects.cjs').createProjectStore({ fs, path, documentSources, storageClient: {},
    rag: { indexProjectFile: async (...a) => { indexed.push(a[1]); return { ok: true, stored: 1, embedded: 1 }; }, deleteProjectFile: () => {} },
    authService: { getStorage: () => ({}) }, currentWorkspace: () => workspace, PROJECTS: [project],
    reasoningEffort: {}, projectAppearance: () => ({}), FREE_CHATS: [], sanitizeToolboxes: () => null, defaultToolboxes: () => [], PROJECT_ROOT_FOLDER: 'fixture-root',
    createProjectFolder: async () => null, projectSweep: { afterDelete: async () => {} } });
  const page = (n, status = 'native', text = `Synthetic upload page ${n}.`) => ({ number: n, status, method: 'native', text });
  try {
    // An upload stored before the completion pass existed: no marker, one page left 'failed'.
    documents.extractDocumentText = async () => ({ text: '[Page 1]\nSynthetic upload page 1.\n\n[Page 2]\n(failed)', pages: 2, pageTexts: [page(1), page(2, 'failed', '')], state: 'partial', truncated: false });
    const uploaded = await documentSources.ingest(workspace, project.id, 'scan.pdf', Buffer.from('%PDF-1.4 synthetic upload'), undefined);
    project.files = [uploaded];
    assert.equal(backfill.uploadCandidate(uploaded, documents.EXTRACTOR_VERSION), true);

    const budgets = [];
    let mode = 'defer';
    documents.completeDocument = async (_name, _bytes, out, deps) => {
      budgets.push(deps?.ocrBudget);
      if (mode === 'defer') { deps.ocrBudget.remaining = 0; return { ...out, completion: undefined }; }
      return { ...out, text: '[Page 1]\nSynthetic upload page 1.\n\n[Page 2]\nRecovered synthetic text.', pageTexts: [page(1), page(2, 'ocr', 'Recovered synthetic text.')], state: 'ready', completion: documents.COMPLETION };
    };
    const budget = { remaining: 40 };
    const r1 = await store.completeUploadedDocument(project, project.files[0], { ocrBudget: budget });
    assert.equal(r1.status, 'deferred');
    assert.equal(budgets[0], budget, 'the pass budget reaches the completion');
    assert.equal(project.files[0].document.completionTries, 1);
    assert.equal(backfill.uploadCandidate(project.files[0], documents.EXTRACTOR_VERSION), true, 'resumes next pass');

    mode = 'finish';
    const r2 = await store.completeUploadedDocument(project, project.files[0], { ocrBudget: { remaining: 40 } });
    assert.equal(r2.status, 'completed');
    const done = project.files[0];
    assert.match(done.content, /Recovered synthetic text/);
    assert.deepEqual(indexed, ['scan.pdf'], 'new text is indexed');
    assert.equal(done.document.completionSweep, done.document.version);
    assert.equal(done.document.completionTries, undefined);
    assert.equal(backfill.uploadCandidate(done, documents.EXTRACTOR_VERSION), false, 'never again');

    // Asked again anyway: the record has its marker, nothing is read.
    const n = budgets.length;
    assert.equal((await store.completeUploadedDocument(project, done, { ocrBudget: { remaining: 40 } })).status, 'complete');
    assert.equal(budgets.length, n);
  } finally { documents.completeDocument = realComplete; documents.extractDocumentText = realExtract; fs.rmSync(dir, { recursive: true, force: true }); }
});
