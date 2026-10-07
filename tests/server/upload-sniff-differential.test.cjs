'use strict';

// Differential tests for the upload checks (#977): the JS references (server/upload-sniff.cjs
// validateJs, classifyJs, decodeTextJs) and their Rust port in dav-parse.wasm (sbstndalton/
// noevia-rs crates/upload-sniff) must agree on every synthetic fixture in
// tests/fixtures/upload-sniff.v1.json (byte-identical to noevia-rs's copy; CI compares them),
// including the exact decoded text, and on seeded random inputs that also carry raw lone
// surrogates in names. The WebAssembly half needs server/wasm/dav-parse.wasm (or DAV_PARSE_WASM);
// it is skipped without it unless DAV_PARSE_WASM_REQUIRED=1.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { isDeepStrictEqual } = require('node:util');

const sniff = require('../../server/upload-sniff.cjs');
const davParseWasm = require('../../server/dav-parse-wasm.cjs');

const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/upload-sniff.v1.json'), 'utf8'));
const wasmFile = process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM;
const skipWasm = !fs.existsSync(wasmFile) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built';

const bytesOf = (c) => { const b = Buffer.alloc(c.len); Buffer.from(c.head, 'hex').copy(b); return b; };
const refusalOf = (fn) => {
  try { fn(); return null; } catch (err) {
    const m = err.message;
    if (m.startsWith('Use a plain')) return { refusal: 'filename', status: err.status };
    if (m.startsWith('Archive')) return { refusal: 'archive', status: err.status };
    if (m.startsWith('Files must')) return { refusal: err.status === 413 ? 'too_big' : 'empty', status: err.status };
    return { error: m };
  }
};

test('the JS references reproduce every committed expectation', () => {
  assert.equal(fixtures.version, 1);
  assert.equal(fixtures.cap, sniff.CAP);
  assert.ok(fixtures.validate.length >= 1500 && fixtures.classify.length >= 1500 && fixtures.decode.length >= 3000);
  for (const c of fixtures.validate) assert.deepEqual(refusalOf(() => sniff.validateJs(c.name, bytesOf(c))), c.expect, c.name);
  for (const c of fixtures.classify) assert.equal(sniff.classifyJs(c.name), c.expect, c.name);
  for (const c of fixtures.decode) assert.deepEqual(sniff.decodeTextJs(Buffer.from(c.bytes, 'hex')), c.expect, c.name);
});

test('Node decodes windows-1252 0x80-0x9F as the WHATWG index (incl. the five undefined bytes)', () => {
  const want = [0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
    0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178];
  const got = sniff.decodeTextJs(Buffer.from(want.map((_, i) => 0x80 + i)));
  assert.equal(got.encoding, 'windows-1252');
  assert.deepEqual([...got.text].map((c) => c.codePointAt(0)), want);
});

test('dav-parse.wasm upload checks agree with the JS reference on every fixture', { skip: skipWasm }, () => {
  davParseWasm.reset();
  const badV = fixtures.validate.filter((c) => !isDeepStrictEqual(refusalOf(() => sniff.validate(c.name, bytesOf(c), { impl: 'wasm' })), c.expect));
  assert.deepEqual(badV.map((c) => c.name), [], `${badV.length} of ${fixtures.validate.length} validate fixtures disagree`);
  const badC = fixtures.classify.filter((c) => sniff.classify(c.name, { impl: 'wasm' }) !== c.expect);
  assert.deepEqual(badC.map((c) => c.name), [], `${badC.length} of ${fixtures.classify.length} classify fixtures disagree`);
  const badD = fixtures.decode.filter((c) => !isDeepStrictEqual(sniff.decodeText(Buffer.from(c.bytes, 'hex'), { impl: 'wasm' }), c.expect));
  assert.deepEqual(badD.map((c) => c.name), [], `${badD.length} of ${fixtures.decode.length} decode fixtures disagree`);
  console.log(`# upload-sniff differential: ${fixtures.validate.length} validate, ${fixtures.classify.length} classify, ${fixtures.decode.length} decode fixtures agree`);
});

test('dav-parse.wasm agrees with the JS references on seeded random uploads and names', { skip: skipWasm }, () => {
  let seed = 0x977977;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  const int = (n) => Math.floor(rand() * n);
  const pick = (a) => a[int(a.length)];
  const pieces = ['a', 'é', '😀', '.', '..', '/', '\\', ' ', '\t', '\u0000', 'K', 'İ', '\ud800', '\udc00', '.docx', '.zip', '.MD', '.txt', '.tar', 'x'.repeat(90)];
  const gen = (max) => { let s = ''; for (let i = int(max); i > 0; i--) s += pick(pieces); return s; };
  const heads = [[0x50, 0x4b, 3, 4], [0x1f, 0x8b], [0x52, 0x61, 0x72, 0x21], [0x37, 0x7a, 0xbc, 0xaf], [0x42, 0x5a, 0x68], [0xef, 0xbb, 0xbf], [0xff, 0xfe], [0xfe, 0xff], [0], [0xc3, 0xa9], [0xed, 0xa0, 0x80], [0x80], [0x9d]];
  let n = 0;
  for (; n < 2000; n++) {
    const name = gen(6);
    const parts = [];
    for (let i = int(40); i > 0; i--) parts.push(...(rand() < 0.3 ? pick(heads) : [int(256)]));
    if (rand() < 0.2) { while (parts.length < 257) parts.push(0x20); parts.splice(257, 5, ...Buffer.from('ustar')); }
    const bytes = Buffer.from(parts);
    assert.deepEqual(refusalOf(() => sniff.validate(name, bytes, { impl: 'wasm' })), refusalOf(() => sniff.validateJs(name, bytes)), `random validate ${n}: ${JSON.stringify(name)} ${bytes.toString('hex')}`);
    assert.equal(sniff.classify(name, { impl: 'wasm' }), sniff.classifyJs(name), `random classify ${n}: ${JSON.stringify(name)}`);
    assert.deepEqual(sniff.decodeText(bytes, { impl: 'wasm' }), sniff.decodeTextJs(bytes), `random decode ${n}: ${bytes.toString('hex')}`);
  }
  console.log(`# upload-sniff differential: ${n}/${n} random names and uploads agree`);
});
