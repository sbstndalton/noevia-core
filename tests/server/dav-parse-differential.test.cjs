'use strict';

// Differential test for the PROPFIND listing parser (#967): the JS reference
// (server/dav-listing.cjs listingRecordsJs) and dav-parse.wasm (sbstndalton/noevia-rs
// crates/dav-parse) must agree on every synthetic fixture in tests/fixtures/dav-listing.v1.json
// (byte-identical to noevia-rs's copy; CI compares them) and on seeded random listings that also
// carry raw lone surrogates. The WebAssembly half needs server/wasm/dav-parse.wasm (or
// DAV_PARSE_WASM); it is skipped without it unless DAV_PARSE_WASM_REQUIRED=1.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { listingRecordsJs } = require('../../server/dav-listing.cjs');
const davParseWasm = require('../../server/dav-parse-wasm.cjs');

const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/dav-listing.v1.json'), 'utf8'));
const wasmFile = process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM;
const skipWasm = !fs.existsSync(wasmFile) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built';

const run = (fn, body, target) => { try { return { entries: fn(body, target) }; } catch (e) { return { error: e instanceof davParseWasm.DavParseError ? e.reason : 'invalid_target' }; } };

test('the JS reference reproduces every committed expectation', () => {
  assert.equal(fixtures.version, 1);
  assert.ok(fixtures.cases.length >= 500);
  for (const c of fixtures.cases) assert.deepEqual(run(listingRecordsJs, c.body, c.target), c.expect, c.name);
});

test('dav-parse.wasm agrees with the JS reference on every fixture', { skip: skipWasm }, () => {
  davParseWasm.reset();
  const bad = fixtures.cases.filter((c) => !isDeepStrictEqual(run(davParseWasm.listRecords, c.body, c.target), c.expect));
  assert.deepEqual(bad.map((c) => c.name), [], `${bad.length} of ${fixtures.cases.length} fixtures disagree`);
  console.log(`# dav-parse differential: ${fixtures.cases.length}/${fixtures.cases.length} fixtures agree`);
});

test('dav-parse.wasm agrees with the JS reference on seeded random listings', { skip: skipWasm }, () => {
  let seed = 0xda5;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const D = '/remote.php/dav/files/alice/Notes';
  const T = `https://dav.example.test${D}/`;
  const pieces = ['a', '.', '..', '/', '%', '%2e', '%2F', '%25', '%C3%A9', '%C3', '%ED%A0%80', '%00', '\\', '&amp;', '&#47;', '&#x2e;', '&#xD800;', '&#0;', '&x;', '&', '#', '?',
    ' ', '\t', '\n', ' ', '\u0085', '﻿', '　', 'é', '😀', '\ud800', '\udc00', '<', '>', ':', '@', 'Notes', 'http://x', '//', '‮', 'ǅ', 'İ', 'ﬀ',
    // #969-#971: encoded dot segments/separators, C0/DEL/C1 and every bidi control, raw and encoded.
    '..%2f', '%2e%2e%2F', '..%5c', '%5C', '%7F', '\u007f', '%01', '\u0001', '%C2%80', '%C2%85', '%C2%9F', '\u0080', '\u009b', '&#x85;', '&#127;', '&#92;',
    '\u202a', '\u202b', '\u202c', '\u202d', '\u202e', '\u2066', '\u2067', '\u2068', '\u2069', '\u200e', '\u200f', '\u061c', '%E2%80%8F', '%D8%9C', '&#x2069;', '\u200b', '\u206a'];
  const prefixes = [`${D}/`, `${D}/`, '', '../', `https://dav.example.test${D}/`, `//other.example.test${D}/`, D, `${D}/Sub/`, 'Notes/', 'file:', 'http://[::1]/',
    `https://dav.example.test:443${D}/`, `https://dav.example.test:8443${D}/`, `http://dav.example.test${D}/`, `HTTPS://DAV.example.test${D}/`, `https://u:p@dav.example.test${D}/`,
    `https://dav.example.test@evil.example.test${D}/`, `https://bücher.example.test${D}/`, `https://xn--bcher-kva.example.test${D}/`, `https://ｄａｖ.example.test${D}/`, `ftp://dav.example.test${D}/`, `/\\evil.example.test${D}/`];
  const tp = ['d', 'D', '', 'lp1', 'x-y'];
  const tag = (p, n) => (p ? `${p}:${n}` : n);
  let n = 0;
  for (; n < 3000; n++) {
    let body = '';
    for (let b = Math.floor(rand() * 6); b > 0; b--) {
      let name = '';
      for (let i = 1 + Math.floor(rand() * 6); i > 0; i--) name += pick(pieces);
      const p = pick(tp);
      body += `<${tag(p, 'response')}><${tag(p, 'href')}>${pick(prefixes)}${name}</${tag(pick(tp), 'href')}>`
        + (rand() < 0.3 ? `<${tag(pick(tp), 'collection')}${pick(['', '/', ' /', ' /', '\u0085/'])}>` : '')
        + (rand() < 0.5 ? `<${tag(pick(tp), 'getcontentlength')}>${pick(['1', '007', '', 'x', '١', '99999999999999999999999'])}<` : '')
        + (rand() < 0.95 ? `</${tag(p, 'response')}>` : '');
    }
    const target = rand() < 0.9 ? T : pick(['https://dav.example.test/', 'https://dav.example.test/a%2Fb/', `https://dav.example.test:8443${D}/`, `http://dav.example.test${D}/`, `https://xn--bcher-kva.example.test${D}/`, 'https://dav.example.test/%C3%A9/', 'nope', 'https://dav.example.test/%zz/']);
    const js = run(listingRecordsJs, body, target), wasm = run(davParseWasm.listRecords, body, target);
    assert.deepEqual(wasm, js, `random case ${n}: ${JSON.stringify({ body, target })}`);
  }
  console.log(`# dav-parse differential: ${n}/${n} random listings agree`);
});

function isDeepStrictEqual(a, b) { return require('node:util').isDeepStrictEqual(a, b); }
