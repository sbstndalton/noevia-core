'use strict';

// UPLOAD_SNIFF_IMPL (#977): js is the default and unchanged; wasm runs the Rust port inside
// dav-parse.wasm and fails closed with a fixed public message (400 for input that cannot cross,
// 500 for a module failure). Synthetic names and bytes only.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const davParseWasm = require('./dav-parse-wasm.cjs');
const sniff = require('./upload-sniff.cjs');
const uploads = require('./uploads.cjs');

const wasmFile = process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM;
const required = process.env.DAV_PARSE_WASM_REQUIRED === '1';
const skipWasm = !fs.existsSync(wasmFile) && !required && 'dav-parse.wasm not built (set DAV_PARSE_WASM_REQUIRED=1 to require it)';
const MISSING = path.join(os.tmpdir(), 'no-such-upload-dav-parse.wasm');

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  davParseWasm.reset();
  try { return fn(); } finally {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    davParseWasm.reset();
  }
}

test('UPLOAD_SNIFF_IMPL defaults to js; unknown values mean js with one warning', (t) => {
  const fn = sniff.uploadSniffImpl;
  assert.equal(fn({}), 'js');
  assert.equal(fn({ UPLOAD_SNIFF_IMPL: '' }), 'js');
  assert.equal(fn({ UPLOAD_SNIFF_IMPL: ' WASM ' }), 'wasm');
  const warn = t.mock.method(console, 'warn', () => {});
  assert.equal(fn({ UPLOAD_SNIFF_IMPL: 'rust' }), 'js');
  assert.equal(fn({ UPLOAD_SNIFF_IMPL: 'rust' }), 'js');
  assert.equal(warn.mock.callCount(), 1);
});

test('uploads.cjs uses the switch: the default path is the JS reference', () => {
  withEnv({ UPLOAD_SNIFF_IMPL: undefined, DAV_PARSE_WASM: MISSING }, () => {
    assert.equal(uploads.classify('notes.md'), 'Text');
    assert.doesNotThrow(() => uploads.validate('notes.md', Buffer.from('synthetic')));
  });
});

test('wasm fails closed with a fixed 500 when the module is missing; nothing falls back', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  withEnv({ UPLOAD_SNIFF_IMPL: 'wasm', DAV_PARSE_WASM: MISSING }, () => {
    for (const call of [() => uploads.validate('notes.md', Buffer.from('x')), () => uploads.classify('notes.md'), () => sniff.decodeText(Buffer.from('x'))]) {
      assert.throws(call, (err) => err.message === sniff.PUBLIC_FAILURE && err.status === 500 && err.code === 'upload_sniff_failed' && !err.message.includes(MISSING));
    }
  });
  assert.ok(warn.mock.calls.some((c) => String(c.arguments[0]).includes('missing')), 'details are logged server-side');
});

test('wasm fails closed when the module bytes do not match the lock', (t) => {
  t.mock.method(console, 'warn', () => {});
  const tampered = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'upload-sniff-')), 'dav-parse.wasm');
  fs.writeFileSync(tampered, Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
  withEnv({ UPLOAD_SNIFF_IMPL: 'wasm', DAV_PARSE_WASM: tampered }, () => {
    assert.throws(() => uploads.classify('a.md'), (err) => err.status === 500 && err.reason === 'checksum');
  });
});

test('wasm: input that cannot cross is a 400 with the same fixed message', { skip: skipWasm }, (t) => {
  t.mock.method(console, 'warn', () => {});
  withEnv({ UPLOAD_SNIFF_IMPL: 'wasm' }, () => {
    for (const call of [() => sniff.classify(42), () => sniff.decodeText('text'), () => sniff.validate('a.md', 'text'),
      () => sniff.decodeText(Buffer.alloc(davParseWasm.MAX_DECODE_BYTES + 1, 0x61))]) {
      assert.throws(call, (err) => err.message === sniff.PUBLIC_FAILURE && err.status === 400);
    }
    // A non-string name is not a plain filename (as storage-path's wasm rule), not a crash.
    assert.throws(() => sniff.validate(42, Buffer.from('x')), (err) => /plain filename/.test(err.message) && err.status === 400);
  });
});

test('wasm: refusals carry the JS messages and statuses; caps at 25 MB ±1', { skip: skipWasm }, () => {
  withEnv({ UPLOAD_SNIFF_IMPL: 'wasm' }, () => {
    const cap = sniff.CAP;
    assert.doesNotThrow(() => sniff.validate('big.txt', Buffer.alloc(cap, 0x61)));
    assert.throws(() => sniff.validate('big.txt', Buffer.alloc(cap + 1, 0x61)), (e) => e.status === 413 && /25 MB/.test(e.message));
    assert.throws(() => sniff.validate('empty.txt', Buffer.alloc(0)), (e) => e.status === 400 && /non-empty/.test(e.message));
    assert.throws(() => sniff.validate('../x.txt', Buffer.from('x')), (e) => e.status === 400 && /plain filename/.test(e.message));
    assert.throws(() => sniff.validate('a.bin', Buffer.from([0x50, 0x4b, 3, 4])), (e) => e.status === 400 && /Archive/.test(e.message));
    assert.doesNotThrow(() => sniff.validate('a.docx', Buffer.from([0x50, 0x4b, 3, 4])));
    // A name far past 200 characters (and one with a lone surrogate) answers as the JS rule does.
    assert.throws(() => sniff.validate('x'.repeat(100000) + '.txt', Buffer.from('x')), (e) => e.status === 400 && /plain filename/.test(e.message));
    assert.doesNotThrow(() => sniff.validate('a\ud800.txt', Buffer.from('x')));
    assert.throws(() => sniff.validate('😀'.repeat(100) + '\ud83d', Buffer.from('x')), /plain filename/);
  });
});

test('wasm: a 25 MB decode matches Node and the instance is reset afterwards', { skip: skipWasm }, () => {
  withEnv({ UPLOAD_SNIFF_IMPL: 'wasm' }, () => {
    const bytes = Buffer.alloc(sniff.CAP, 0x80); // all windows-1252 '€': the 3x-expansion worst case
    const got = sniff.decodeText(bytes);
    assert.equal(got.encoding, 'windows-1252');
    assert.equal(got.text.length, sniff.CAP);
    assert.ok(got.text === sniff.decodeTextJs(bytes).text);
    // The grown instance was dropped; the next call starts from a fresh, small one.
    assert.equal(davParseWasm.memoryBytes(), 0);
    assert.equal(sniff.decodeText(Buffer.from('ok')).text, 'ok');
    const base = davParseWasm.memoryBytes();
    assert.ok(base > 0 && base < 8 * 1024 * 1024, `fresh instance memory ${base}`);
  });
});

test('decodeText under wasm reads the same text and encoding caveat as under js', { skip: skipWasm }, () => {
  for (const bytes of [Buffer.from('café', 'latin1'), Buffer.from([0xff, 0xfe, 0x61, 0]), Buffer.from('plain'), Buffer.from('a\0b')]) {
    const js = sniff.decodeText(bytes, { impl: 'js' });
    const wasm = withEnv({ UPLOAD_SNIFF_IMPL: 'wasm' }, () => sniff.decodeText(bytes));
    assert.deepEqual(wasm, js);
  }
});
