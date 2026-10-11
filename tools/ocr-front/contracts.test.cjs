'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { requireScan } = require('./contracts.cjs');
const upload = { document: { state: 'ready', pageStatus: [{ number: 1, status: 'ocr' }] } };
const text = '[OCR transcription — verify numbers against original]\nREF-2042\n2042-01-02 UTILITIES 42.15\n2042-01-03 REFUND -7.20\nTOTAL 34.95';
test('scan oracle requires OCR status and exact synthetic rows', () => {
  requireScan(upload, { text });
  assert.throws(() => requireScan({ document: { state: 'failed' } }, {}), /native OCR must make/);
  assert.throws(() => requireScan({ document: { state: 'ready', pageStatus: [{ number: 1, status: 'native' }] } }, { text }), /scan must be labelled OCR/);
  assert.throws(() => requireScan(upload, { text: text.replace('34.95', '34.96') }), /native OCR must recover synthetic row: TOTAL 34.95/);
  assert.throws(() => requireScan(upload, { text: '' }), /native OCR must recover/);
});
const { createHash } = require('node:crypto');
const { requireReducedPdf, REDUCED_CAP, REDUCED_TEXT } = require('./contracts.cjs');
function reducedFixture(suffix = '', artifact) {
  // Synthetic helper input. Real Poppler parsing of authenticated downloads is mandatory in run.cjs.
  const bytes = artifact || Buffer.from('%PDF-1.6\nsynthetic helper artifact' + suffix);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const extractor = 'synthetic-extractor';
  const version = createHash('sha256').update(hash + ':' + extractor).digest('hex');
  const document = { bytes: bytes.length, byteHash: hash, availableByteHash: hash, extractor, version, availableVersion: version, pages: 1, state: 'ready' };
  const attachment = { bytes: bytes.length, id: hash, reduction: { kind: 'pdf', originalBytes: 26 * 1024 * 1024 } };
  return { large: { bytes: bytes.length, attachment: structuredClone(attachment), document: structuredClone(document) }, reduced: { name: 'large.compressed.pdf', attachment, document }, downloaded: { bytes, contentLength: String(bytes.length), contentType: 'application/pdf' }, extracted: { pages: 1, text: REDUCED_TEXT + '\n\f' } };
}
const validate = f => requireReducedPdf(f.large, f.reduced, f.downloaded, f.extracted);
test('reduced PDF comparison normalizes only independently validated derived counts', () => {
  const a = reducedFixture(), b = reducedFixture('different compressed metadata');
  const left = validate(a), right = validate(b);
  assert.equal(left.large.bytes, '<reduced-length>');
  assert.equal(right.reduced.document.bytes, '<reduced-length>');
  assert.equal(left.large.attachment.reduction.originalBytes, 26 * 1024 * 1024);
  assert.equal(a.large.bytes, a.downloaded.bytes.length, 'validation must preserve raw input');
  assert.notEqual(left.large.document.byteHash, right.large.document.byteHash, 'hash identity remains for the existing separate binding');
  assert.equal(left.reduced.name, a.reduced.name);
});
test('each reduced byte-count field remains bound to actual artifact bytes', () => {
  for (const [owner, field] of [['large','bytes'],['large.attachment','bytes'],['large.document','bytes'],['reduced.attachment','bytes'],['reduced.document','bytes']]) {
    const f = reducedFixture();
    const target = owner.split('.').reduce((value, key) => value[key], f);
    target[field]++;
    assert.throws(() => validate(f), /metadata bytes must match/);
  }
  const f = reducedFixture(); f.downloaded.contentLength = String(f.downloaded.bytes.length + 1);
  assert.throws(() => validate(f), /Content-Length must match/);
});
test('download hash, version, PDF signature, cap and exact extracted text are mandatory', () => {
  for (const [owner, field] of [['large.attachment','id'],['reduced.attachment','id'],['large.document','byteHash'],['large.document','availableByteHash'],['reduced.document','byteHash'],['reduced.document','availableByteHash']]) {
    const f = reducedFixture(); owner.split('.').reduce((value, key) => value[key], f)[field] = 'wrong';
    assert.throws(() => validate(f), /metadata hash must match/);
  }
  const version = reducedFixture(); version.reduced.document.availableVersion = 'wrong';
  assert.throws(() => validate(version), /available reduced version must bind/);
  const signature = reducedFixture(); signature.downloaded.bytes[0] = 0;
  assert.throws(() => validate(signature), /artifact must be a PDF/);
  const over = Buffer.alloc(REDUCED_CAP + 1, 32); Buffer.from('%PDF-').copy(over);
  const cap = reducedFixture('', over);
  assert.throws(() => validate(cap), /actual byte cap/);
  const empty = reducedFixture(); empty.downloaded.bytes = Buffer.alloc(0);
  assert.throws(() => validate(empty), /actual byte cap/);
  const type = reducedFixture(); type.downloaded.contentType = 'text/plain';
  assert.throws(() => validate(type), /PDF content type/);
  const text = reducedFixture(); text.extracted.text = REDUCED_TEXT.replace('REDUCTION', 'CORRUPTION');
  assert.throws(() => validate(text), /exact synthetic text/);
  const pages = reducedFixture(); pages.extracted.pages = 2;
  assert.throws(() => validate(pages), /preserve the synthetic page/);
});
