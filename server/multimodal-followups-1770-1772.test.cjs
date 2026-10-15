'use strict';
// #1770 (sweep existing documents for figures), #1771 (the media pass creates no index for a project
// without images) and #1772 (how the image preset leaves after a pass is reported). Synthetic
// projects, bytes and records only; no model, no network, no real document.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

delete process.env.RAG_DIR;
for (const k of ['EMBEDDING_BASE_URL', 'EMBEDDING_MODEL', 'EMBED_MODEL', 'EMBEDDING_PROFILE', 'EMBEDDING_NEXT_MODEL', 'EMBEDDING_NEXT_BASE_URL', 'EMBEDDING_NEXT_PROFILE', 'EMBEDDING_IMAGE_MODEL', 'NOEVIA_MULTIMODAL_RAG']) delete process.env[k];

const multimodal = require('./multimodal-rag.cjs');
const { createEmbeddingConfig } = require('./embedding-config.cjs');
const sweepMod = require('./figure-sweep.cjs');

let depsOk = true;
try { require('better-sqlite3'); require('sqlite-vec'); } catch { depsOk = false; }
const dbTest = depsOk ? test : test.skip;

const USER = '22222222-2222-4222-8222-222222222222';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const walk = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String) : []);

function freshRag(dir) {
  delete require.cache[require.resolve('./rag.cjs')];
  const rag = require('./rag.cjs');
  // An address nothing listens on: the tests below never reach it (embedParts is injected).
  const config = createEmbeddingConfig({ env: { EMBEDDING_BASE_URL: 'http://127.0.0.1:9', EMBEDDING_MODEL: 'gemma-test', EMBEDDING_PROFILE: 'embeddinggemma-2' }, stateFile: path.join(dir, 'embedding-config.json') });
  rag.init({ dataDir: dir, inferenceUrl: 'http://engine.invalid', embeddingConfig: config,
    userDataDirFn: (id) => path.join(dir, 'users', id), listUserIds: () => [USER], userActive: () => true });
  return rag;
}

// ── #1771 ────────────────────────────────────────────────────────────────────────────────────────
dbTest('#1771: a media pass over projects with no index and no images creates no file', async () => {
  const dir = tmp('mm-1771-');
  const rag = freshRag(dir);
  const projects = ['cowork-chat-context-c-1-a', 'cowork-chat-context-c-2-b', 'proj-text-only'].map((id) => ({ id, files: [{ name: 'notes.txt', content: 'synthetic text' }], assets: [] }));
  const workspace = { userId: USER, dir: path.join(dir, 'ws'), assetDir: (id) => path.join(dir, 'ws', 'assets', id), projects };
  const before = walk(dir);
  const backfill = multimodal.createMediaBackfill({ enabled: () => true, userIds: () => [USER], workspaceFor: () => workspace,
    documentDir: () => path.join(dir, 'ws', 'docs'), rag, sleep: async () => {}, log: () => {}, setTimer: () => 1, clearTimer: () => {} });
  await backfill.kick();
  assert.deepEqual(walk(dir), before, 'no index file, -wal/-shm or rag directory was created');
  assert.equal(fs.existsSync(path.join(dir, 'users', USER, 'rag')), false);
  // Direct call too: nothing to reconcile and no index means nothing is opened.
  const r = await rag.syncProjectMedia('cowork-chat-context-c-3-c', USER, [], { limit: 1 });
  assert.equal(r.ok, true);
  assert.deepEqual(walk(dir), before);
});

dbTest('#1771: a project that already has an index is still reconciled when its last image goes', async () => {
  process.env.EMBEDDING_IMAGE_MODEL = 'gemma-test';
  const dir = tmp('mm-1771b-');
  try {
    const rag = freshRag(dir);
    const bytes = Buffer.from('synthetic picture');
    const item = { file: 'pic.png', hash: `img:${sha(bytes)}`, label: 'Image pic.png', meta: { source: 'pic.png' }, part: () => ({ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }) };
    const first = await rag.syncProjectMedia('proj-a', USER, [item], { limit: 1, embedParts: async () => [[0.1, 0.2, 0.3, 0.4]] });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.embedded, 1);
    const file = path.join(dir, 'users', USER, 'rag', 'proj-a.db');
    assert.ok(fs.existsSync(file));
    const second = await rag.syncProjectMedia('proj-a', USER, [], { limit: 1 });
    assert.equal(second.removed, 1, 'the stale image row is removed');
    assert.ok(fs.existsSync(file), 'an existing index is kept (never deleted here)');
  } finally { delete process.env.EMBEDDING_IMAGE_MODEL; }
});

// ── #1772 ────────────────────────────────────────────────────────────────────────────────────────
function oneImageBackfill(release, logs) {
  const workspace = { userId: USER, projects: [{ id: 'p1', files: [], assets: [] }] };
  let calls = 0;
  const rag = { syncProjectMedia: async () => (++calls === 1 ? { ok: true, embedded: 1, pending: 0 } : { ok: true, embedded: 0, pending: 0 }) };
  return multimodal.createMediaBackfill({ enabled: () => true, userIds: () => [USER], workspaceFor: () => workspace, documentDir: () => '/nonexistent',
    rag, release, sleep: async () => {}, log: (l) => logs.push(l), setTimer: () => 1, clearTimer: () => {} });
}

test('#1772: an image preset already evicted by the router is reported, not silently counted as released', async () => {
  const logs = [];
  await oneImageBackfill(async () => ({ released: false, alias: 'gemma.vision', status: 400, evicted: true }), logs).kick();
  assert.ok(logs.some((l) => /gemma\.vision was already unloaded by the embeddings router's eviction/.test(l) && /--models-max/.test(l)), logs.join('\n'));
});

test('#1772: an explicit unload after a pass is logged', async () => {
  const logs = [];
  await oneImageBackfill(async () => ({ released: true, alias: 'gemma.vision' }), logs).kick();
  assert.ok(logs.some((l) => l === '[media] unloaded gemma.vision after the pass'), logs.join('\n'));
});

dbTest('#1772: releaseMediaModel unloads only the .vision alias and tells an eviction apart', async () => {
  const dir = tmp('mm-1772-');
  const rag = freshRag(dir);
  const service = require('./embedding-service.cjs');
  const before = service.current();
  service.install({ managed: () => true, isAt: () => true, status: () => ({ vision: [{ model: 'gemma-test', alias: 'gemma-test.vision' }] }) });
  const posted = [];
  let answer = { ok: true, status: 200, text: '{}' };
  const prev = rag._test.setRagFetch(async (url, init) => {
    posted.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(answer.text, { status: answer.status });
  });
  try {
    assert.deepEqual(await rag.releaseMediaModel(), { released: true, alias: 'gemma-test.vision' });
    answer = { status: 400, text: '{"error":{"message":"model is not running"}}' };
    const r = await rag.releaseMediaModel();
    assert.equal(r.released, false);
    assert.equal(r.evicted, true);
    assert.deepEqual(posted.map((p) => [new URL(p.url).pathname, p.body.model]), [['/models/unload', 'gemma-test.vision'], ['/models/unload', 'gemma-test.vision']], 'never a text model');
  } finally { rag._test.setRagFetch(prev); service.install(before); }
});

// ── #1770 ────────────────────────────────────────────────────────────────────────────────────────
const V = (c) => c.repeat(64);
function docFile(name, { extractor = 'docling-pages-v1:d1', version = V('a'), byteHash = V('b'), ...rest } = {}) {
  return { name, content: 'synthetic text', document: { version, byteHash, availableVersion: version, extractor, state: 'ready', ...rest } };
}
function sweepFixture({ flag = true, extractor = 'docling-pages-v1:d1:figures-v1', records = {}, refreshImpl, env = {}, paused = () => null } = {}) {
  const calls = [];
  const sleeps = [];
  const projects = [
    { id: 'proj-1', files: [docFile('a.pdf'), docFile('b.pdf', { version: V('c') }), docFile('scan.pdf', { version: V('d') }), docFile('new.pdf', { extractor: 'docling-pages-v1:d1:figures-v1' }), { name: 'notes.txt', content: 'x' }] },
    { id: require('./diary-extras.cjs').PROJECT_ID, files: [docFile('diary.pdf')] },
    { id: 'cowork-chat-context-diary-7', files: [docFile('chat.pdf')] },
  ];
  const workspace = { userId: USER, projects };
  const recordsAll = { [V('d')]: { pageTexts: [{ number: 1, status: 'ocr', ocr: true }, { number: 2, status: 'blank' }] }, ...records };
  const fsImpl = { readFileSync: (p) => { const r = recordsAll[path.basename(p, '.json')]; if (!r) throw new Error('ENOENT'); return JSON.stringify(r); } };
  let t = 0;
  const sweep = sweepMod.createFigureSweep({ enabled: () => flag, extractorVersion: () => extractor, userIds: () => [USER], workspaceFor: () => workspace,
    documentDir: () => '/synthetic', fsImpl, env, paused,
    runAs: (userId, fn) => { calls.push(['runAs', userId]); return fn(); },
    refresh: async (project, file) => {
      calls.push([project.id, file.name]);
      t += 300; // 300 ms of extraction
      if (refreshImpl) return refreshImpl(project, file);
      file.document = { ...file.document, extractor, version: V('e') };
      return { status: 'refreshed' };
    },
    sleep: async (ms) => { sleeps.push(ms); }, now: () => t, log: () => {} });
  return { sweep, calls, sleeps, projects };
}

test('#1770: flag off (or no figures in the extractor) never runs', async () => {
  for (const opts of [{ flag: false }, { flag: true, extractor: 'docling-pages-v1:d1' }]) {
    const f = sweepFixture(opts);
    assert.equal(f.sweep.kick(), null);
    await f.sweep.idle();
    assert.deepEqual(f.calls, []);
  }
});

test('#1770: re-reads only figure-less documents, never Diary projects or scanned documents, paced by the duty', async () => {
  const f = sweepFixture({ env: { EMBEDDING_REINDEX_DUTY: '0.25', NOEVIA_MULTIMODAL_RAG_INTERVAL_MS: '100' } });
  const totals = await f.sweep.kick();
  const reads = f.calls.filter((c) => c[0] !== 'runAs');
  assert.deepEqual(reads, [['proj-1', 'a.pdf'], ['proj-1', 'b.pdf']]);
  assert.ok(f.calls.filter((c) => c[0] === 'runAs').every((c) => c[1] === USER), 'each read in its owner scope');
  assert.equal(totals.refreshed, 2);
  // busy 300 ms at duty 0.25 -> 900 ms pause (above the 100 ms minimum).
  assert.deepEqual(f.sleeps, [900, 900]);
  // Once per version: a second pass finds nothing left.
  const again = await f.sweep.kick();
  assert.equal(again.refreshed, 0);
  assert.equal(f.calls.filter((c) => c[0] !== 'runAs').length, 2);
});

test('#1770: bounded per pass; a failure is tried once per version; a transient one ends the pass and is retried', async () => {
  const bounded = sweepFixture({ env: { NOEVIA_MULTIMODAL_FIGURE_SWEEP_MAX: '1' } });
  const t1 = await bounded.sweep.kick();
  assert.equal(t1.refreshed, 1);
  assert.equal(t1.remaining, 1);
  await bounded.sweep.kick();
  assert.equal(bounded.calls.filter((c) => c[0] !== 'runAs').length, 2);

  // A permanent failure marks the version tried (what projects.cjs refreshDocumentFigures does).
  const failing = sweepFixture({ refreshImpl: async (_p, file) => { file.document.figureSweep = file.document.version; return { status: 'failed' }; } });
  assert.equal((await failing.sweep.kick()).failed, 2);
  assert.equal((await failing.sweep.kick()).failed, 0, 'not tried again at the same version');

  // Docling itself unreachable: nothing marked, the pass stops at the first one, the next pass tries again.
  const down = sweepFixture({ refreshImpl: async () => ({ status: 'retry', unreachable: true, error: 'Document extraction is busy' }) });
  const t3 = await down.sweep.kick();
  assert.match(t3.reason, /extraction is unavailable: Document extraction is busy/);
  assert.equal(down.calls.filter((c) => c[0] !== 'runAs').length, 1);
  await down.sweep.kick();
  assert.equal(down.calls.filter((c) => c[0] !== 'runAs').length, 2);
});

test('#1770 review: one document with a transient failure is skipped and counted; later documents are still read', async () => {
  const f = sweepFixture({ refreshImpl: async (_p, file) => {
    if (file.name === 'a.pdf') return { status: 'retry', unreachable: false, error: 'Invalid extraction response' };
    file.document = { ...file.document, extractor: 'docling-pages-v1:d1:figures-v1' };
    return { status: 'refreshed' };
  } });
  const t = await f.sweep.kick();
  assert.equal(t.reason, null);
  assert.equal(t.deferred, 1);
  assert.equal(t.refreshed, 1);
  assert.deepEqual(f.calls.filter((c) => c[0] !== 'runAs'), [['proj-1', 'a.pdf'], ['proj-1', 'b.pdf']], 'b.pdf is read although a.pdf failed first');
  const again = await f.sweep.kick();
  assert.equal(again.deferred, 1, 'a.pdf (not marked) is tried again on the next pass');
});

test('#1770 review: the sweep and the image pass never run at the same time; an image pass scheduled mid-sweep starts after it', async () => {
  const events = [];
  let release;
  const blocker = new Promise((r) => { release = r; });
  const f = sweepFixture({ refreshImpl: async (_p, file) => {
    events.push(`sweep:start:${file.name}`);
    if (file.name === 'a.pdf') {
      backfill.schedule(USER, 'proj-1'); // what indexSource -> sourceChanged does
      await new Promise((r) => setImmediate(r));
      await blocker;
    }
    file.document = { ...file.document, extractor: 'docling-pages-v1:d1:figures-v1' };
    events.push(`sweep:end:${file.name}`);
    return { status: 'refreshed' };
  } });
  const workspace = { userId: USER, projects: [{ id: 'proj-1', files: [], assets: [] }] };
  const rag = { syncProjectMedia: async () => { events.push('image-pass'); return { ok: true, embedded: 0, pending: 0 }; } };
  const backfill = multimodal.createMediaBackfill({ enabled: () => true, userIds: () => [USER], workspaceFor: () => workspace, documentDir: () => '/nonexistent',
    rag, sleep: async () => {}, log: () => {}, setTimer: () => 1, clearTimer: () => {} });
  const sweeping = f.sweep.kick();
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(!events.includes('image-pass'), 'the image pass waits while the sweep runs');
  release();
  await sweeping;
  await backfill.idle();
  assert.ok(events.indexOf('image-pass') > events.lastIndexOf('sweep:end:b.pdf'), events.join(','));
  // And the other way round: a sweep kicked while an image pass runs starts after it.
  const order = [];
  let open;
  const held = new Promise((r) => { open = r; });
  const p1 = multimodal.exclusive('image pass', async () => { order.push('image:start'); await held; order.push('image:end'); });
  const g = sweepFixture({ refreshImpl: async () => { order.push('sweep'); return { status: 'failed' }; } });
  const p2 = g.sweep.kick();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(order, ['image:start']);
  open();
  await Promise.all([p1, p2]);
  assert.equal(order[1], 'image:end');
  assert.equal(order[2], 'sweep');
});

test('#1770: holds while a re-index is under way', async () => {
  const f = sweepFixture({ paused: () => 'a re-index is under way' });
  const totals = await f.sweep.kick();
  assert.equal(totals.reason, 'a re-index is under way');
  assert.deepEqual(f.calls, []);
});

test('#1770: refreshDocumentFigures re-reads the stored original, keeps text on failure, and marks the version', async () => {
  const documents = require('./documents.cjs');
  const documentSources = require('./document-sources.cjs');
  const realExtract = documents.extractDocumentText;
  const realVersion = documents.EXTRACTOR_VERSION;
  const dir = tmp('mm-1770-');
  const project = { id: 'proj-doc', files: [] };
  const workspace = { assetDir: (id) => path.join(dir, 'assets', id), dir: path.join(dir, 'ws'), userId: USER, projects: [project], saveProjects: () => {} };
  const indexed = [];
  const store = require('./projects.cjs').createProjectStore({ fs, path, documentSources, storageClient: {},
    rag: { indexProjectFile: async (...a) => { indexed.push(a[1]); return { ok: true, stored: 1, embedded: 1 }; }, deleteProjectFile: () => {} },
    authService: { getStorage: () => ({}) }, currentWorkspace: () => workspace, PROJECTS: [project],
    reasoningEffort: {}, projectAppearance: () => ({}), FREE_CHATS: [], sanitizeToolboxes: () => null, defaultToolboxes: () => [], PROJECT_ROOT_FOLDER: 'fixture-root',
    createProjectFolder: async () => null, projectSweep: { afterDelete: async () => {} } });
  const pdf = Buffer.from('%PDF-1.4 synthetic');
  let mode = 'old';
  documents.extractDocumentText = async () => {
    if (mode === 'down') return { text: '', pages: 0, pageTexts: [], state: 'failed', truncated: false, retryable: true, error: 'docling unreachable' };
    if (mode === 'broken') return { text: '', pages: 0, pageTexts: [], state: 'failed', truncated: false, retryable: false, error: 'unreadable' };
    return { text: '[Page 1]\nSynthetic', pages: 1, pageTexts: [{ number: 1, status: 'native', text: 'Synthetic' }], state: 'ready', truncated: false,
      ...(mode === 'figures' ? { figures: [{ page: 1, index: 0, ext: 'png', bytes: Buffer.from('synthetic figure') }] } : {}) };
  };
  try {
    documents.EXTRACTOR_VERSION = 'docling-pages-v1:d1';
    const original = await documentSources.ingest(workspace, project.id, 'r.pdf', pdf, undefined);
    project.files = [original];

    documents.EXTRACTOR_VERSION = 'docling-pages-v1:d1:figures-v1';
    mode = 'down';
    assert.equal((await store.refreshDocumentFigures(project, project.files[0])).status, 'retry');
    assert.equal(project.files[0], original, 'kept as it was');
    assert.equal(original.document.figureSweep, undefined, 'a transient failure is not marked');

    mode = 'figures';
    assert.equal((await store.refreshDocumentFigures(project, project.files[0])).status, 'refreshed');
    const updated = project.files[0];
    assert.notEqual(updated, original);
    assert.match(updated.document.extractor, /:figures-v1$/);
    assert.equal(updated.content, original.content);
    const record = JSON.parse(fs.readFileSync(path.join(documentSources.directory(workspace, project.id), `${updated.document.availableVersion}.json`), 'utf8'));
    assert.equal(record.figures.length, 1);
    assert.deepEqual(indexed, ['r.pdf']);
    assert.equal(sweepMod.needsFigures(updated, record), false, 'not a candidate again');

    // Review of #116: a reading that is worse than the current one never replaces it, and the version is marked tried.
    const savedExtract = documents.extractDocumentText;
    const worse = async (name, result) => {
      documents.extractDocumentText = savedExtract;
      documents.EXTRACTOR_VERSION = 'docling-pages-v1:w-' + name;
      const good = await documentSources.ingest(workspace, project.id, name, Buffer.from('%PDF-1.4 ' + name), undefined);
      project.files = [...project.files, good];
      documents.EXTRACTOR_VERSION = 'docling-pages-v1:w-' + name + ':figures-v1';
      documents.extractDocumentText = async () => result;
      const r = await store.refreshDocumentFigures(project, good);
      assert.equal(r.status, 'worse', name);
      assert.ok(project.files.includes(good), `${name}: the current record stays`);
      assert.equal(good.content, '[Page 1]\nSynthetic');
      assert.equal(good.document.figureSweep, good.document.version);
    };
    await worse('partial.pdf', { text: '[Page 1]\nSyn', pages: 1, pageTexts: [{ number: 1, status: 'degraded', text: 'Syn' }], state: 'partial', truncated: false, figures: [] });
    await worse('empty.pdf', { text: '', pages: 1, pageTexts: [{ number: 1, status: 'blank', text: '' }], state: 'ready', truncated: false });
    await worse('fewer.pdf', { text: 'x', pages: 1, pageTexts: [], state: 'ready', truncated: false });
    documents.extractDocumentText = savedExtract;

    // A permanent failure at a new version keeps the text and marks that version tried.
    documents.EXTRACTOR_VERSION = 'docling-pages-v1:d2';
    const older = await documentSources.ingest(workspace, project.id, 'q.pdf', Buffer.from('%PDF-1.4 other'), undefined);
    project.files = [...project.files, older];
    const olderIndex = project.files.length - 1;
    documents.EXTRACTOR_VERSION = 'docling-pages-v1:d2:figures-v1';
    mode = 'broken';
    assert.equal((await store.refreshDocumentFigures(project, older)).status, 'failed');
    assert.equal(project.files[olderIndex], older);
    assert.equal(older.content, '[Page 1]\nSynthetic');
    assert.equal(older.document.figureSweep, older.document.version);
    assert.equal(sweepMod.needsFigures(older, null), false);
  } finally { documents.extractDocumentText = realExtract; documents.EXTRACTOR_VERSION = realVersion; }
});

test('#1770 re-review: a document that times out is deferred and later documents are still swept', async () => {
  const documentSources = require('./document-sources.cjs');
  const timeoutError = 'Document extraction unavailable: The operation was aborted due to timeout';
  // What projects.cjs refreshDocumentFigures returns for a retryable failure.
  const f = sweepFixture({ refreshImpl: async (_p, file) => {
    if (file.name === 'a.pdf') return { status: 'retry', unreachable: documentSources.serviceDown(timeoutError), error: timeoutError };
    file.document = { ...file.document, extractor: 'docling-pages-v1:d1:figures-v1' };
    return { status: 'refreshed' };
  } });
  const t = await f.sweep.kick();
  assert.equal(t.reason, null);
  assert.equal(t.deferred, 1);
  assert.deepEqual(f.calls.filter((c) => c[0] !== 'runAs'), [['proj-1', 'a.pdf'], ['proj-1', 'b.pdf']]);
  // Outages still end the pass.
  for (const e of ['fetch failed: ECONNREFUSED', 'getaddrinfo ENOTFOUND docling', 'Document extraction is busy; refresh to retry.']) assert.equal(documentSources.serviceDown(e), true, e);
  // Two timeouts in a row end the pass.
  const g = sweepFixture({ refreshImpl: async () => ({ status: 'retry', unreachable: false, error: 'request timed out' }) });
  const t2 = await g.sweep.kick();
  assert.match(t2.reason, /timed out twice/);
  assert.equal(g.calls.filter((c) => c[0] !== 'runAs').length, 2);
});
