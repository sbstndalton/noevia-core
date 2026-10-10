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
