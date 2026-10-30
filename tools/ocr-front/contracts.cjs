'use strict';
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
// This assertion is also used by the two end-to-end controls. A missing worker,
// omitted page, empty response, or plausible but incorrect OCR must fail it.
function requireScan(upload, pages) {
  assert.equal(upload.document?.state, 'ready', 'native OCR must make the scan ready');
  // Docling reads the page as "ocr-needed", the native OCR worker recovers it, and the front records both: the
  // page is labelled OCR and carries the retry's outcome (sbstndalton/noevia#2191 round 8).
  assert.deepEqual(upload.document.pageStatus, [{ number: 1, status: 'ocr', retry: { outcome: 'recovered' } }], 'scan must be labelled OCR');
  for (const text of ['REF-2042', '2042-01-02 UTILITIES 42.15', '2042-01-03 REFUND -7.20', 'TOTAL 34.95']) {
    assert.ok(pages.text?.includes(text), `native OCR must recover synthetic row: ${text}`);
  }
  assert.ok(pages.text.includes('[OCR transcription — verify numbers against original]'));
}
// Independent Ghostscript runs may produce different PDFs. Bind every identity and size to
// the authenticated downloaded artifact before normalizing only its derived size fields.
const REDUCED_CAP = 25 * 1024 * 1024;
const REDUCED_TEXT = 'SYNTHETIC NATIVE TEXT FOR REDUCTION';
function requireReducedPdf(large, reduced, downloaded, extracted) {
  const { bytes, contentLength, contentType } = downloaded;
  assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= REDUCED_CAP, 'reduced PDF must fit the actual byte cap');
  assert.equal(contentType, 'application/pdf', 'reduced download must have PDF content type');
  assert.equal(contentLength, String(bytes.length), 'reduced Content-Length must match actual downloaded bytes');
  assert.ok(bytes.subarray(0, 5).equals(Buffer.from('%PDF-')), 'reduced artifact must be a PDF');
  assert.equal(large.attachment.reduction.kind, 'pdf');
  assert.ok(reduced?.document && reduced?.attachment, 'reduced workspace metadata must exist');
  for (const count of [large.bytes, large.attachment.bytes, large.document?.bytes, reduced.attachment.bytes, reduced.document.bytes]) {
    assert.equal(count, bytes.length, 'reduced metadata bytes must match actual downloaded bytes');
  }
  const hash = createHash('sha256').update(bytes).digest('hex');
  for (const identity of [large.attachment.id, reduced.attachment.id, large.document.byteHash, large.document.availableByteHash, reduced.document.byteHash, reduced.document.availableByteHash]) {
    assert.equal(identity, hash, 'reduced metadata hash must match actual downloaded bytes');
  }
  for (const document of [large.document, reduced.document]) {
    const version = createHash('sha256').update(hash + ':' + document.extractor).digest('hex');
    assert.equal(document.version, version, 'reduced version must bind bytes and extractor');
    assert.equal(document.availableVersion, version, 'available reduced version must bind bytes and extractor');
    assert.equal(document.pages, 1, 'reduced metadata must preserve the synthetic page');
  }
  assert.equal(extracted.pages, 1, 'downloaded PDF must preserve the synthetic page');
  assert.equal(extracted.text.trim(), REDUCED_TEXT, 'downloaded PDF must preserve exact synthetic text');
  const stable = value => ({ ...value, attachment: { ...value.attachment, bytes: '<reduced-length>' }, document: { ...value.document, bytes: '<reduced-length>' } });
  return { large: { ...stable(large), bytes: '<reduced-length>' }, reduced: stable(reduced) };
}
// The source-work requests a second person must get a 404 on, with the bodies they send (the front's own
// tenant refusal, before any worker is called): the upload, the sync and the folder-import plan.
function sourceWorkDenials(route, uploadBody) {
  return [
    ['POST', route + '/upload', uploadBody],
    ['POST', route + '/sources/sync', {}],
    ['POST', route + '/folder-import/plan', { entries: [{ path: 'docs/a.md', size: 3 }] }],
  ];
}
module.exports = { requireScan, requireReducedPdf, sourceWorkDenials, REDUCED_CAP, REDUCED_TEXT };
