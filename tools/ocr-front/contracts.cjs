'use strict';
const assert = require('node:assert/strict');
// This assertion is also used by the two end-to-end controls. A missing worker,
// omitted page, empty response, or plausible but incorrect OCR must fail it.
function requireScan(upload, pages) {
  assert.equal(upload.document?.state, 'ready', 'native OCR must make the scan ready');
  assert.deepEqual(upload.document.pageStatus, [{ number: 1, status: 'ocr' }], 'scan must be labelled OCR');
  for (const text of ['REF-2042', '2042-01-02 UTILITIES 42.15', '2042-01-03 REFUND -7.20', 'TOTAL 34.95']) {
    assert.ok(pages.text?.includes(text), `native OCR must recover synthetic row: ${text}`);
  }
  assert.ok(pages.text.includes('[OCR transcription — verify numbers against original]'));
}
module.exports = { requireScan };
