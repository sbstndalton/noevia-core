'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const sources = require('./document-sources.cjs');
const documents = require('./documents.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-source-store-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures/documents', name));
const workspace = user => ({ dir: path.join(root, user) });

test('page reads reach the last page beyond the project summary cap and paginate', async () => {
  const w = workspace('pages');
  const f = await sources.ingest(w, 'p', 'long.pdf', fixture('long.pdf'));
  assert.equal(f.document.truncated, true);
  assert.equal(f.content.includes('PAGE-110'), false);
  const last = sources.readPages(w, 'p', f, 110);
  assert.match(last.text, /PAGE-110 ROW-50/);
  const first = sources.readPages(w, 'p', f, 1, 5, 0, 100);
  assert.equal(first.nextOffset, 100);
  const next = sources.readPages(w, 'p', f, 1, 5, 100, 100);
  assert.notEqual(first.text, next.text);
  const server = fs.readFileSync(path.join(__dirname, 'index.cjs'), 'utf8');
  const context = { require, documents, documentSources: sources, currentWorkspace: () => w, TOOL_RESULT_CAP: 8000 };
  vm.createContext(context);
  vm.runInContext(server.slice(server.indexOf('async function executeToolCall('), server.indexOf('async function executeMcpToolCall(')), context);
  const out = await context.executeToolCall({ id: 'p', files: [f] }, 'read_project_file', JSON.stringify({ name: 'long.pdf', startPage: 110 }));
  assert.match(out, /PAGE-110 ROW-50/); assert.match(out, /text version/);
});

test('extractor cache survives restart but is never reused between projects or users', async () => {
  const bytes = fixture('text.pdf');
  const a = await sources.ingest(workspace('a'), 'p1', '../../statement.pdf', bytes);
  const original = documents.extractDocumentText;
  let calls = 0;
  documents.extractDocumentText = async (...args) => { calls++; return original(...args); };
  try {
    const repeat = await sources.ingest(workspace('a'), 'p1', '../../statement.pdf', bytes, a);
    assert.equal(repeat.document.version, a.document.version); assert.equal(calls, 0);
    await sources.ingest(workspace('a'), 'p2', 'statement.pdf', bytes);
    await sources.ingest(workspace('b'), 'p1', 'statement.pdf', bytes);
    assert.equal(calls, 2);
  } finally { documents.extractDocumentText = original; }
  assert.notEqual(sources.directory(workspace('a'), 'p1'), sources.directory(workspace('b'), 'p1'));
  assert.deepEqual(sources.readOriginal(workspace('a'), 'p1', a), bytes);
});

test('new failed document has no stale content; later corrected bytes recover it', async () => {
  const w = workspace('recover');
  const fail = await sources.ingest(w, 'p', 'a.pdf', fixture('scanned.pdf'));
  assert.equal(fail.document.state, 'failed'); assert.equal(fail.document.stale, false);
  assert.equal(fail.content, '');
  const ok = await sources.ingest(w, 'p', 'a.pdf', fixture('text.pdf'), fail);
  assert.equal(ok.document.state, 'ready'); assert.equal(ok.document.stale, false);
  assert.notEqual(ok.document.version, fail.document.version);
});

test('page chunking retains page labels on every chunk', () => {
  const rag = require('./rag.cjs');
  const chunks = rag.chunkText('[Page 1]\n' + 'one '.repeat(1000) + '\n\n[Page 2]\n' + 'two '.repeat(1000));
  assert.ok(chunks.length > 2);
  assert.ok(chunks.every(c => /^\[Page [12]\]/.test(c)));
  assert.ok(chunks.some(c => c.startsWith('[Page 2]')));
});
