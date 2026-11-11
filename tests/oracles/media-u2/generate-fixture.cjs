'use strict';
// Synthetic oracle. Run against the pre-port Core tree with Node 22; its stdout is fixtures/media-u2-node.json.
// It lives outside server/ so no production module or image ships an oracle load (oracle-isolation.test.cjs).
const backfill = require('./document-backfill.cjs');
const figures = require('./figure-sweep.cjs');
const rag = require('../../../server/rag.cjs');
const hash = 'a'.repeat(64);
const base = { name: 'sample.pdf', content: 'head', document: { version: hash, byteHash: hash, availableVersion: hash, extractor: 'old', indexing: 'ready', state: 'ready' } };
const cases = [
  ['plain', { name: 'sample.txt' }, null],
  ['document', base, null],
  ['figure-tried', { ...base, document: { ...base.document, figureSweep: hash } }, null],
  ['figure-new-version', { ...base, document: { ...base.document, figureSweep: 'b'.repeat(64) } }, null],
  ['new-extractor', { ...base, document: { ...base.document, extractor: 'old:figures-v1' } }, null],
  ['scan', base, { pageTexts: [{ number: 1, status: 'ocr', text: 'scan' }] }],
  ['mixed-scan', base, { pageTexts: [{ number: 1, status: 'ocr' }, { number: 2, status: 'native' }] }],
  ['blank', base, { pageTexts: [{ number: 1, status: 'blank' }] }],
  ['image', { ...base, name: 'sample.PNG' }, null],
  ['queued', { ...base, document: { ...base.document, state: 'queued' } }, null],
  ['failed', { ...base, document: { ...base.document, state: 'failed' } }, null],
  ['upload-tried', { ...base, document: { ...base.document, completionSweep: hash } }, null],
  ['connected', { ...base, source: { path: '/synthetic' } }, null],
  ['tail-complete', { ...base, document: { ...base.document, searchable: { version: hash, page: null, complete: true } } }, null],
  ['tail-old-complete', { ...base, document: { ...base.document, searchable: { version: 'b'.repeat(64), page: null, complete: true } } }, null],
  ['direct', { ...base, document: { ...base.document, indexing: 'direct' } }, null],
];
const candidates = cases.map(([name, file, record]) => ({ name, file, record, figures: figures.needsFigures(file, record), upload: backfill.uploadCandidate(file, 'old'), tail: backfill.tailCandidate(file, 4, f => (f.content || '').length) }));
const pages = { pageTexts: [{ number: 3, status: 'native', text: 'third' }, { number: 1, status: 'native', text: 'first' }, { number: 2, status: 'ocr', text: 'second' }] };
const head = '[Page 1]\nfirst\n\n[Page 2]\nsec';
const windows = [
  ['all', head, {}], ['resume', head, { fromPage: 3 }], ['limited', head, { textLimit: 30 }],
  ['one-window', head, { maxChars: 1 }], ['mismatch', 'unrelated', {}], ['empty-head', '', {}],
].map(([name, content, options]) => ({ name, content, record: pages, options, result: backfill.tailWindow(content, pages, { chunkText: rag.chunkText, ...options }) }));
const source = require('node:fs').readFileSync(require.resolve('../../../server/rag.cjs'), 'utf8');
const clampSource = source.match(/^function clampInt[^\n]+/m)?.[0];
if (!clampSource) throw new Error('Node clampInt oracle unavailable');
const clamp = require('node:vm').runInNewContext(`(${clampSource})`, {}, { timeout: 2000 });
const timeouts = [null, '', '  -1', '10000junk', '+12000.5', '1e4', '0x10', '600001', 'invalid', '9'.repeat(400)].map(raw => ({ raw, result: clamp(raw, 120000, 5000, 600000) }));
process.stdout.write(JSON.stringify({ candidates, windows, timeouts, settings: [{ env: { PROJECT_TAIL_EMBED_BATCH: '0x10', PROJECT_TAIL_EMBED_PER_PASS: '0b100', PROJECT_UPLOAD_COMPLETION_PER_PASS: '0o3' }, result: backfill.settings({ PROJECT_TAIL_EMBED_BATCH: '0x10', PROJECT_TAIL_EMBED_PER_PASS: '0b100', PROJECT_UPLOAD_COMPLETION_PER_PASS: '0o3' }) }, { env: {}, result: backfill.settings({}) }, { env: { PROJECT_BACKFILL_DUTY: '0', PROJECT_TAIL_EMBED_BATCH: '100', PROJECT_UPLOAD_COMPLETION_PER_PASS: '0' }, result: backfill.settings({ PROJECT_BACKFILL_DUTY: '0', PROJECT_TAIL_EMBED_BATCH: '100', PROJECT_UPLOAD_COMPLETION_PER_PASS: '0' }) }] }, null, 2) + '\n');
