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
  assert.ok(['noNativeText', 'noOcrText'].includes(scan.errorId), 'noevia-written extraction errors carry an id the browser translates (#607)');
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

// Run the real upload/sync/delete routes (routes/projects.cjs over projects.cjs) with synthetic
// storage and real extraction. No server bootstrap, credentials, diary, network, or persisted state.
const uploads = require('./uploads.cjs');
const realIngest = uploads.ingest;
let currentStorage = null;
// The routes reach uploads.ingest through the module, so the harness's storage is handed in here.
uploads.ingest = (...args) => { args[4] = { ...args[4], storageImpl: currentStorage }; return realIngest(...args); };
test.after(() => { uploads.ingest = realIngest; });





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
      if (['fs', 'path', 'crypto', './document-sources.cjs', './prompt-framing.cjs', './http.cjs', './quoted-name.cjs', './embedding-profile.cjs', './embedding-config.cjs', './vector-slots.cjs'].includes(name)) return require(name);
      throw new Error('Optional index intentionally unavailable in synthetic test');
    },
  };
  vm.createContext(context);
  vm.runInContext(ragSource, context);
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










test('retrieval fallback stays within the files-context budget, smallest first, naming omitted files', async () => {
  const ragSource = fs.readFileSync(path.join(__dirname, 'rag.cjs'), 'utf8');
  const context = { module: { exports: {} }, process: { env: {} }, console: { warn: () => {} },
    require: name => {
      if (['fs', 'path', 'crypto', './document-sources.cjs', './prompt-framing.cjs', './http.cjs', './quoted-name.cjs', './embedding-profile.cjs', './embedding-config.cjs', './vector-slots.cjs'].includes(name)) return require(name);
      throw new Error('Optional index intentionally unavailable in synthetic test');
    },
  };
  vm.createContext(context);
  vm.runInContext(ragSource, context);
  const files = Array.from({ length: 60 }, (_, i) => ({ name: `big-${i}.md`, content: `BIG${i} ` + 'y'.repeat(30000 - 1000 + i * 10) }));
  files.push({ name: 'tiny.md', content: 'TINY-MARKER' });
  const out = await context.module.exports.filesContext('fixture-project', files, 'q', 'fixture-user');
  const [manifest] = out.split('\n\n');
  const body = out.slice(manifest.length);
  assert.ok(body.length <= 120_000 + 1000, `body ${body.length}`);
  assert.match(out, /TINY-MARKER/);
  assert.match(out, /BIG0 /); // the shortest of the large files goes in first
  assert.equal(out.includes('BIG59 '), false);
  assert.match(manifest, /more files not included/);
  assert.match(manifest, /"big-59\.md"/);
  const included = files.filter((f) => out.includes(`label="${f.name}"`)).length;
  const omitted = Number(manifest.match(/ (\d+) more files not included/)[1]);
  assert.equal(included + omitted, files.length);
});


// #1864: a large PDF that arrives through storage (an attached folder, or the project's own synced
// folder) is read and indexed, not skipped for its size. Synthetic: a text page plus padding.
function largeSyntheticPdf(marker, padding) {
  const content = `BT /F1 12 Tf 72 720 Td (${marker}) Tj ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${content.length} >>\nstream\n${content}\nendstream`];
  const parts = [Buffer.from('%PDF-1.4\n')]; let size = parts[0].length; const offsets = [];
  const push = (b) => { parts.push(b); size += b.length; };
  objects.forEach((o, i) => { offsets.push(size); push(Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`)); });
  offsets.push(size); push(Buffer.from(`6 0 obj\n<< /Length ${padding} >>\nstream\n`)); push(Buffer.alloc(padding, 0x41)); push(Buffer.from('\nendstream\nendobj\n'));
  const xref = size;
  push(Buffer.from(`xref\n0 7\n0000000000 65535 f \n${offsets.map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`));
  return Buffer.concat(parts);
}


