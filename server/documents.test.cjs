'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const documents = require('./documents.cjs');
const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures/documents', name));

test('text PDF preserves synthetic dates, signed amounts and total', async () => {
  const out = await documents.extractDocumentText('text.pdf', fixture('text.pdf'));
  assert.equal(out.pages, 1);
  for (const value of ['TEXT-P1', '2042-01-02', '42.15', '-7.20', '34.95']) assert.ok(out.text.includes(value));
  assert.equal(out.truncated, false);
});

test('scans, encrypted PDFs and malformed bytes fail explicitly', async () => {
  await assert.rejects(documents.extractDocumentText('scanned.pdf', fixture('scanned.pdf')), e => e.status === 422 && /OCR/.test(e.message));
  await assert.rejects(documents.extractDocumentText('encrypted.pdf', fixture('encrypted.pdf')), /password/i);
  await assert.rejects(documents.extractDocumentText('malformed.pdf', fixture('malformed.pdf')), /Invalid PDF/);
});

// Characterization of known gaps, not desired OCR acceptance criteria. Replace
// these assertions when the page-aware extraction scope in the spec ships.
test('audit: mixed PDFs currently omit scanned content without reporting partial extraction', async () => {
  for (const name of ['mixed-pages.pdf', 'mixed-page.pdf']) {
    const out = await documents.extractDocumentText(name, fixture(name));
    assert.equal(out.text.includes('SCAN-P2'), false);
    assert.equal(out.truncated, false);
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
const sync = source.slice(source.indexOf('    const projSync ='), source.indexOf('    const chatDel ='));
function harness(remote = false) {
  const project = { id: 'fixture-project', files: [], projectFolder: 'fixture', sourceFolders: remote ? ['fixture'] : [] };
  const stored = new Map();
  let extracts = 0;
  const context = {
    Buffer, console, Date, DOCUMENT_UPLOAD_CAP: 25 * 1024 * 1024,
    PROJECTS: [project], getProject: id => id === project.id ? project : null,
    saveProjects: () => {}, currentWorkspace: () => ({ userId: 'fixture-user' }),
    authService: { getStorage: () => ({}) },
    readBody: async req => JSON.stringify(req.body),
    json: (_res, status, body) => ({ status, body }),
    documents: { ...documents, extractDocumentText: async (...args) => { extracts++; return documents.extractDocumentText(...args); } },
    rag: { indexProjectFile: async () => {}, deleteProjectFile: () => {} },
    storageClient: {
      TEXT_EXTENSIONS: new Set(['.txt']), isBrowsable: () => remote,
      writeFile: async (_conn, name, bytes) => stored.set(name, bytes),
      listFiles: async () => [...stored.keys()].map(p => ({ name: p.split('/').pop(), path: p, ext: '.pdf' })),
      readBinaryFile: async (_conn, name) => stored.get(name),
    },
  };
  vm.createContext(context);
  const run = vm.runInContext('(async function(p, req) { const res = {}; const authn = {user:{id:"fixture-user"}};\n' + upload + sync + '\n})', context);
  return { project, stored, extracts: () => extracts,
    upload: (name, bytes, id = project.id) => run('/api/projects/' + id + '/upload', { method: 'POST', body: { name, dataBase64: bytes.toString('base64') } }),
    sync: () => run('/api/projects/' + project.id + '/sources/sync', { method: 'POST' }),
  };
}

test('local PDF upload extracts text; failed replacement preserves prior text', async () => {
  const h = harness();
  assert.equal((await h.upload('statement.pdf', fixture('text.pdf'))).status, 200);
  const before = h.project.files[0].content;
  assert.equal((await h.upload('statement.pdf', fixture('scanned.pdf'))).status, 422);
  assert.equal(h.project.files[0].content, before);
  assert.equal(h.stored.size, 0, 'local path currently does not retain original bytes');
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
  assert.equal(h.project.files.length, 1);
  assert.equal(h.project.files[0].content, before);
  assert.equal(h.project.files[0].name, 'fixture/old.pdf');
});

test('audit: upload/sync omit truncation metadata and unchanged sync re-extracts', async () => {
  const local = harness();
  const uploaded = await local.upload('long.pdf', fixture('long.pdf'));
  assert.equal(uploaded.body.truncated, undefined);
  assert.equal(local.project.files[0].content.length, documents.EXTRACT_CAP);
  const remote = harness(true);
  await remote.upload('long.pdf', fixture('long.pdf'));
  const synced = await remote.sync();
  assert.equal(synced.body.files[0].truncated, undefined);
  await remote.sync();
  assert.equal(remote.extracts(), 2);
});

test('upload rejects oversized bytes and a project outside the current workspace', async () => {
  const h = harness();
  assert.equal((await h.upload('large.pdf', Buffer.alloc(25 * 1024 * 1024 + 1))).status, 413);
  assert.equal((await h.upload('text.pdf', fixture('text.pdf'), 'another-users-project')).status, 404);
  assert.equal(h.extracts(), 0);
});

test('audit: S3 binary reader currently changes non-UTF8 bytes and bypasses its cap', async () => {
  const originalFetch = global.fetch;
  const storage = require('./storage-client.cjs');
  const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0xff, 0x80, 0x00]);
  global.fetch = async () => new Response(bytes);
  try {
    const out = await storage.readBinaryFile({ kind: 's3', baseUrl: 'http://fixture.invalid/bucket', corpusRoot: '', username: '', secret: '' }, 'test.pdf', { cap: 1 });
    assert.notDeepEqual(out, bytes);
    assert.ok(out.length > 1);
  } finally { global.fetch = originalFetch; }
});

test('audit: retrieval fallback retains source names but supplies only the head of large files', async () => {
  const ragSource = fs.readFileSync(path.join(__dirname, 'rag.cjs'), 'utf8');
  const context = { module: { exports: {} }, process: { env: {} }, console: { warn: () => {} },
    require: name => {
      if (['fs', 'path', 'crypto'].includes(name)) return require(name);
      throw new Error('Optional index intentionally unavailable in synthetic test');
    },
  };
  vm.createContext(context); vm.runInContext(ragSource, context);
  const out = await context.module.exports.filesContext('fixture-project', [
    { name: 'small.pdf', content: 'TOTAL 34.95' },
    { name: 'large.pdf', content: 'HEAD-MARKER ' + 'x'.repeat(30000) + ' TAIL-MARKER' },
  ], 'What is at the end?', 'fixture-user');
  assert.match(out, /small.pdf/); assert.match(out, /TOTAL 34.95/);
  assert.match(out, /large.pdf/); assert.match(out, /HEAD-MARKER/);
  assert.equal(out.includes('TAIL-MARKER'), false);
});
