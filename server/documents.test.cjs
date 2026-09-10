'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const documents = require('./documents.cjs');
const documentSources = require('./document-sources.cjs');
const os = require('node:os');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-documents-'));
test.after(() => fs.rmSync(testDir, { recursive: true, force: true }));
let workspaceNumber = 0;
const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures/documents', name));

test('text PDF preserves synthetic dates, signed amounts and total', async () => {
  const out = await documents.extractDocumentText('text.pdf', fixture('text.pdf'));
  assert.equal(out.pages, 1);
  for (const value of ['TEXT-P1', '2042-01-02', '42.15', '-7.20', '34.95']) assert.ok(out.text.includes(value));
  assert.equal(out.truncated, false);
});

test('scans, encrypted PDFs and malformed bytes fail explicitly', async () => {
  const scan = await documents.extractDocumentText('scanned.pdf', fixture('scanned.pdf'));
  assert.equal(scan.state, 'failed'); assert.match(scan.error, /OCR/);
  await assert.rejects(documents.extractDocumentText('encrypted.pdf', fixture('encrypted.pdf')), /Password/i);
  await assert.rejects(documents.extractDocumentText('malformed.pdf', fixture('malformed.pdf')), /parse this PDF/);
});

test('mixed PDFs explicitly report incomplete scanned pages', async () => {
  for (const name of ['mixed-pages.pdf', 'mixed-page.pdf']) {
    const out = await documents.extractDocumentText(name, fixture(name));
    assert.equal(out.text.includes('SCAN-P2'), false);
    assert.equal(out.state, 'partial');
    assert.ok(out.pageTexts.some(p => p.status === 'ocr-needed'));
    assert.equal(out.pages, name === 'mixed-pages.pdf' ? 2 : 1);
  }
});

test('large extracted text reports the 200k cap', async () => {
  const out = await documents.extractDocumentText('long.pdf', fixture('long.pdf'));
  assert.equal(out.pages, 110);
  assert.equal(out.text.length, documents.EXTRACT_CAP);
  assert.equal(out.truncated, true);
});

// Run real upload/sync route bodies with synthetic storage and real extraction.
// No server bootstrap, credentials, diary, network, or persisted state.
const source = fs.readFileSync(path.join(__dirname, 'index.cjs'), 'utf8');
const upload = source.slice(source.indexOf('    const projUpload ='), source.indexOf('    const projFileDel ='));
const deletion = source.slice(source.indexOf('    const projFileDel ='), source.indexOf('    const projAssets ='));
const sync = source.slice(source.indexOf('    const projSync ='), source.indexOf('    const chatDel ='));
function harness(remote = false) {
  const project = { id: 'fixture-project', files: [], projectFolder: 'fixture', sourceFolders: remote ? ['fixture'] : [] };
  const stored = new Map();
  const workspace = { assetDir: id => path.join(testDir, 'assets', id), dir: path.join(testDir, String(++workspaceNumber)), userId: 'fixture-user', projects: [project], saveProjects: () => {} };
  let extracts = 0;
  const context = {
    Buffer, console, Date, fs, path, DOCUMENT_UPLOAD_CAP: 25 * 1024 * 1024,
    documentSources, readJson: async req => req.body,
    ownsFile: (project, target) => project.sourceFolders.some(folder => target.startsWith(folder + '/') && !target.slice(folder.length + 1).includes('/')),
    PROJECTS: [project], getProject: id => id === project.id ? project : null,
    saveProjects: () => {}, currentWorkspace: () => workspace,
    authService: { getStorage: () => ({}) },
    require: name => name === './uploads.cjs' ? { ...require(name), ingest: (...args) => { args[4] = { ...args[4], storageImpl: context.storageClient }; return require(name).ingest(...args); } } : require(name), requestScope: { getStore: () => ({}) },
    readBody: async req => JSON.stringify(req.body),
    json: (_res, status, body) => ({ status, body }),
    documents: { ...documents, extractDocumentText: async (...args) => { extracts++; return documents.extractDocumentText(...args); } },
    rag: { indexProjectFile: async () => {}, deleteProjectFile: () => {} },
    storageClient: {
      TEXT_EXTENSIONS: new Set(['.txt']), isBrowsable: () => remote,
      createFolder: async () => {},
      writeFile: async (_conn, name, bytes) => stored.set(name, bytes),
      listFiles: async () => [...stored.keys()].map(p => ({ name: p.split('/').pop(), path: p, ext: '.pdf' })),
      readBinaryFile: async (_conn, name) => stored.get(name),
      deleteFile: async (_conn, name) => stored.delete(name),
    },
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function ownsFile('), source.indexOf('/** Create this project')), context);
  vm.runInContext(source.slice(source.indexOf('const sourceOperations ='), source.indexOf('const MAX_PROJECT_IMAGES =')), context);
  const run = vm.runInContext('(async function(p, req) { const res = {}; const authn = {user:{id:"fixture-user"}};\n' + upload + sync + deletion + '\n})', context);
  return { project, stored, workspace, extracts: () => extracts,
    upload: (name, bytes, id = project.id, organized = false) => run('/api/projects/' + id + '/upload', { method: 'POST', body: { name, organized, dataBase64: bytes.toString('base64') } }),
    remove: name => run('/api/projects/' + project.id + '/files', { method: 'DELETE', body: { path: name } }),
    sync: () => run('/api/projects/' + project.id + '/sources/sync', { method: 'POST' }),
  };
}

test('local PDF upload extracts text; failed replacement preserves prior text', async () => {
  const h = harness();
  assert.equal((await h.upload('statement.pdf', fixture('text.pdf'))).status, 200);
  const before = h.project.files[0].content;
  assert.equal((await h.upload('statement.pdf', fixture('scanned.pdf'))).body.document.stale, true);
  assert.equal(h.project.files[0].content, before);
  assert.deepEqual(documentSources.readOriginal(h.workspace, h.project.id, h.project.files[0]), fixture('scanned.pdf'));
  assert.match(documentSources.readPages(h.workspace, h.project.id, h.project.files[0]).text, /TEXT-P1/);
});

test('remote upload preserves original bytes; sync distinguishes existing and new failed sources', async () => {
  const h = harness(true);
  await h.upload('old.pdf', fixture('text.pdf'));
  assert.deepEqual(h.stored.get('fixture/old.pdf'), fixture('text.pdf'));
  await h.sync();
  const before = h.project.files[0].content;
  await h.upload('old.pdf', fixture('scanned.pdf'));
  await h.upload('new.pdf', fixture('scanned.pdf'));
  const out = await h.sync();
  assert.equal(out.body.skipped.length, 2);
  assert.equal(h.project.files.length, 2);
  assert.equal(h.project.files.find(f => f.name === 'fixture/new.pdf').document.stale, false);
  assert.equal(h.project.files[0].content, before);
  assert.equal(h.project.files[0].name, 'fixture/old.pdf');
});

test('upload/sync preserve truncation metadata and unchanged bytes reuse extraction', async () => {
  const local = harness();
  const uploaded = await local.upload('long.pdf', fixture('long.pdf'));
  assert.equal(uploaded.body.document.truncated, true);
  assert.equal(local.project.files[0].content.length, documents.EXTRACT_CAP);
  const remote = harness(true);
  await remote.upload('long.pdf', fixture('long.pdf'));
  const synced = await remote.sync();
  assert.equal(synced.body.files[0].document.truncated, true);
  await remote.sync();
  const old = documents.extractDocumentText;
  documents.extractDocumentText = async () => { throw new Error('unchanged content must not be parsed'); };
  try { await remote.sync(); assert.equal(remote.project.files[0].document.state, 'partial'); }
  finally { documents.extractDocumentText = old; }
});

test('upload rejects oversized bytes and a project outside the current workspace', async () => {
  const h = harness();
  assert.equal((await h.upload('large.pdf', Buffer.alloc(25 * 1024 * 1024 + 1))).status, 413);
  assert.equal((await h.upload('text.pdf', fixture('text.pdf'), 'another-users-project')).status, 404);
  assert.equal(h.extracts(), 0);
});

test('S3 binary reads preserve bytes and enforce the cap', async () => {
  const originalFetch = global.fetch;
  const storage = require('./storage-client.cjs');
  const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0xff, 0x80, 0x00]);
  global.fetch = async () => new Response(bytes);
  try {
    const conn = { kind: 's3', baseUrl: 'http://fixture.invalid', bucket: 'bucket', corpusRoot: '', username: '', secret: '' };
    const out = await storage.readBinaryFile(conn, 'test.pdf');
    assert.deepEqual(out, bytes);
    await assert.rejects(storage.readBinaryFile(conn, 'test.pdf', { cap: 1 }), e => e.status === 413);
  } finally { global.fetch = originalFetch; }
});

test('audit: retrieval fallback retains source names but supplies only the head of large files', async () => {
  const ragSource = fs.readFileSync(path.join(__dirname, 'rag.cjs'), 'utf8');
  const context = { module: { exports: {} }, process: { env: {} }, console: { warn: () => {} },
    require: name => {
      if (['fs', 'path', 'crypto', './document-sources.cjs'].includes(name)) return require(name);
      throw new Error('Optional index intentionally unavailable in synthetic test');
    },
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function ownsFile('), source.indexOf('/** Create this project')), context); vm.runInContext(ragSource, context);
  const out = await context.module.exports.filesContext('fixture-project', [
    { name: 'small.pdf', content: 'TOTAL 34.95' },
    { name: 'large.pdf', content: 'HEAD-MARKER ' + 'x'.repeat(30000) + ' TAIL-MARKER' },
  ], 'What is at the end?', 'fixture-user');
  assert.match(out, /small.pdf/); assert.match(out, /TOTAL 34.95/);
  assert.match(out, /large.pdf/); assert.match(out, /HEAD-MARKER/);
  assert.equal(out.includes('TAIL-MARKER'), false);
});

test('blank PDF pages are kept as blank rather than OCR failures', async () => {
  // A minimal synthetic blank PDF, including a real xref table.
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> >>'];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((obj, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 4\n0000000000 65535 f \n${offsets.slice(1).map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const out = await documents.extractDocumentText('blank.pdf', Buffer.from(pdf));
  assert.equal(out.state, 'ready'); assert.equal(out.pages, 1);
  assert.equal(out.pageTexts[0].status, 'blank');
});

test('a detached folder is not restored when its in-flight refresh finishes', async () => {
  const h = harness(true);
  await h.upload('a.pdf', fixture('text.pdf'));
  const extract = documentSources.ingest;
  let release; const wait = new Promise(resolve => { release = resolve; });
  let entered; const started = new Promise(resolve => { entered = resolve; });
  documentSources.ingest = async (...args) => { entered(); await wait; return extract(...args); };
  try {
    const refresh = h.sync(); await started;
    h.project.sourceFolders = [];
    release(); await refresh;
    assert.equal(h.project.files.filter(f => f.source).length, 0);
  } finally { documentSources.ingest = extract; }
});

test('concurrent source operations serialize so a stale refresh cannot overwrite a later upload', async () => {
  const h = harness(true);
  await h.upload('a.pdf', fixture('text.pdf'));
  const ingest = documentSources.ingest;
  let release; const wait = new Promise(resolve => { release = resolve; });
  let entered; const started = new Promise(resolve => { entered = resolve; });
  let first = true;
  documentSources.ingest = async (...args) => { if (first) { first = false; entered(); await wait; } return ingest(...args); };
  try {
    const refresh = h.sync(); await started;
    const upload = h.upload('a.pdf', fixture('scanned.pdf'));
    release(); await Promise.all([refresh, upload]);
    const f = h.project.files[0];
    assert.equal(f.document.state, 'failed'); assert.equal(f.document.stale, true);
    assert.deepEqual(documentSources.readOriginal(h.workspace, h.project.id, f), fixture('scanned.pdf'));
  } finally { documentSources.ingest = ingest; }
});

test('file deletion waits for refresh and removes the source and cached original', async () => {
  const h = harness(true);
  await h.upload('a.pdf', fixture('text.pdf'));
  const ingest = documentSources.ingest;
  let release; const wait = new Promise(resolve => { release = resolve; });
  let entered; const started = new Promise(resolve => { entered = resolve; });
  documentSources.ingest = async (...args) => { entered(); await wait; return ingest(...args); };
  try {
    const refresh = h.sync(); await started;
    const remove = h.remove('fixture/a.pdf');
    release(); await Promise.all([refresh, remove]);
    assert.equal(h.project.files.length, 0); assert.equal(h.stored.size, 0);
    assert.equal(fs.readdirSync(documentSources.directory(h.workspace, h.project.id)).length, 0);
  } finally { documentSources.ingest = ingest; }
});


test('organized remote refresh preserves opaque files and images, and exact managed paths can be deleted', async () => {
  const h = harness(true);
  for (const name of ['fixture.docx', 'fixture.png', 'fixture.txt']) {
    const out = await h.upload(name, Buffer.from('synthetic bytes'), h.project.id, true);
    assert.equal(out.status, 200, JSON.stringify(out));
  }
  assert.equal(h.project.files.length, 3);
  const refreshed = await h.sync();
  assert.equal(refreshed.status, 200);
  assert.equal(h.project.files.length, 3);
  assert.equal(h.project.files.find(f => f.name.endsWith('.docx')).attachment.state, 'stored');
  assert.equal(h.project.assets.length, 1);
  const image = h.project.files.find(f => f.name.endsWith('.png'));
  assert.equal((await h.remove(image.name)).status, 200);
  assert.equal(h.project.assets.length, 0);
});


test('refresh migrates legacy local images into managed storage without losing their bytes', async () => {
  const h = harness(true);
  const dir = h.workspace.assetDir(h.project.id); fs.mkdirSync(dir, { recursive: true });
  const bytes = Buffer.from('synthetic legacy image'); fs.writeFileSync(path.join(dir, 'img-legacy'), bytes);
  h.project.assets = [{ id: 'img-legacy', name: 'fixture.png', mime: 'image/png', bytes: bytes.length }];
  const out = await h.sync(); assert.equal(out.status, 200);
  assert.deepEqual(h.stored.get('fixture/Images/fixture-img-legacy.png'), bytes);
  assert.equal(h.project.assets.length, 1); assert.equal(h.project.assets[0].storagePath, 'fixture/Images/fixture-img-legacy.png');
  assert.equal(h.project.files.length, 1);
});


test('refresh retains unified batches larger than the retired 40-source folder cap', async () => {
  const h = harness(true);
  for (let i=0; i<41; i++) assert.equal((await h.upload(`fixture-${i}.bin`, Buffer.from('synthetic'), h.project.id, true)).status, 200);
  const out = await h.sync(); assert.equal(out.status, 200);
  assert.equal(h.project.files.length, 41); assert.equal(out.body.skipped.length, 0);
});
