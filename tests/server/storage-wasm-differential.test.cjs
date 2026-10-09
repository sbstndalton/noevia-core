'use strict';

// Differential tests for the S3 page scan (#976) and the storage path rules (#978): the JS
// references (tests/server/oracle/s3-listing.cjs s3PageRecordsJs, server/storage-path.cjs *Js) and their Rust
// ports in dav-parse.wasm (sbstndalton/noevia-rs crates/s3-list-parse, crates/storage-path) must
// agree on every synthetic fixture in tests/fixtures/s3-list.v1.json and storage-path.v1.json
// (byte-identical to noevia-rs's copies; CI compares them) and on seeded random inputs that also
// carry raw lone surrogates. The WebAssembly half needs server/wasm/dav-parse.wasm (or
// DAV_PARSE_WASM); it is skipped without it unless DAV_PARSE_WASM_REQUIRED=1.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { isDeepStrictEqual } = require('node:util');

const { s3PageRecordsJs } = require('./oracle/s3-listing.cjs');
const paths = require('../../server/storage-path.cjs');
const davParseWasm = require('../../server/dav-parse-wasm.cjs');

const load = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures', f), 'utf8'));
const s3Fixtures = load('s3-list.v1.json');
const pathFixtures = load('storage-path.v1.json');
const wasmFile = process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM;
const skipWasm = !fs.existsSync(wasmFile) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built';

const JS_PATH = { safeRelativePath: paths.safeRelativePathJs, cleanRoot: paths.cleanRootJs, joinRoot: paths.joinRootJs, isPlainFilename: paths.isPlainFilenameJs };
const runS3 = (fn, body, prefix) => { try { return fn(body, prefix); } catch (e) { return { error: e instanceof davParseWasm.DavParseError ? e.reason : String(e) }; } };
const wasmPath = (c) => { try { return { value: davParseWasm.storagePath(c.op, c.a, c.b ?? '') }; } catch (e) { return { error: e.reason || String(e) }; } };

test('the JS references reproduce every committed expectation', () => {
  assert.equal(s3Fixtures.version, 1);
  assert.equal(pathFixtures.version, 1);
  assert.ok(s3Fixtures.cases.length >= 500 && pathFixtures.cases.length >= 500);
  for (const c of s3Fixtures.cases) assert.deepEqual(s3PageRecordsJs(c.body, c.prefix), c.expect, c.name);
  for (const c of pathFixtures.cases) assert.deepEqual({ value: JS_PATH[c.op](c.a, c.b) }, c.expect, c.name);
});

test('dav-parse.wasm s3_list agrees with the JS reference on every fixture', { skip: skipWasm }, () => {
  davParseWasm.reset();
  const bad = s3Fixtures.cases.filter((c) => !isDeepStrictEqual(runS3(davParseWasm.s3ListPage, c.body, c.prefix), c.expect));
  assert.deepEqual(bad.map((c) => c.name), [], `${bad.length} of ${s3Fixtures.cases.length} fixtures disagree`);
  console.log(`# s3-list-parse differential: ${s3Fixtures.cases.length}/${s3Fixtures.cases.length} fixtures agree`);
});

test('dav-parse.wasm storage_path agrees with the JS reference on every fixture', { skip: skipWasm }, () => {
  davParseWasm.reset();
  const bad = pathFixtures.cases.filter((c) => !isDeepStrictEqual(wasmPath(c), c.expect));
  assert.deepEqual(bad.map((c) => c.name), [], `${bad.length} of ${pathFixtures.cases.length} fixtures disagree`);
  console.log(`# storage-path differential: ${pathFixtures.cases.length}/${pathFixtures.cases.length} fixtures agree`);
});

test('dav-parse.wasm agrees with the JS references on seeded random S3 pages and paths', { skip: skipWasm }, () => {
  let seed = 0x976978;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const pieces = ['a', 'é', '😀', '.', '..', '/', '//', '\\', '%2e', '%2F', '&amp;', '&#47;', '&#xD800;', '&#0;', '&x;', '&', ' ', '\t', '\n', ' ', ' ', '﻿', '\u0000', '\u0001',
    '\u007f', '\u0085', '‮', '․', '．', 'C:', '\ud800', '\udc00', '<', '>', 'docs/', 'Key', '</Key>'];
  const gen = (max) => { let s = ''; for (let i = Math.floor(rand() * max); i > 0; i--) s += pick(pieces); return s; };
  let n = 0;
  for (; n < 2000; n++) {
    const prefix = pick(['docs/', '', 'été/', 'a&b/', 'x']);
    let body = '';
    for (let b = Math.floor(rand() * 6); b > 0; b--) {
      const name = (rand() < 0.6 ? prefix : '') + gen(6);
      body += rand() < 0.3 ? `<CommonPrefixes><Prefix>${name}</Prefix></CommonPrefixes>`
        : `<Contents><Key>${name}</Key>${rand() < 0.6 ? `<Size>${pick(['1', '007', '', 'x', '١', '99999999999999999999'])}</Size>` : ''}${rand() < 0.95 ? '</Contents>' : ''}`;
    }
    if (rand() < 0.5) body += `<IsTruncated>${pick(['true', ' TRUE ', 'false', ''])}</IsTruncated><NextContinuationToken>${gen(3)}</NextContinuationToken>`;
    // The body crosses through TextEncoder (lone surrogates become U+FFFD), as readCappedText's
    // decoded text never holds one; a prefix that is not well-formed is refused.
    const expect = prefix.isWellFormed() ? s3PageRecordsJs(body.toWellFormed(), prefix) : { error: 'input' };
    assert.deepEqual(runS3(davParseWasm.s3ListPage, body, prefix), expect, `random page ${n}: ${JSON.stringify({ body, prefix })}`);

    const op = pick(['safeRelativePath', 'safeRelativePath', 'cleanRoot', 'joinRoot', 'isPlainFilename']);
    const c = { op, a: gen(10) + (rand() < 0.03 ? 'x'.repeat(490) : ''), b: op === 'joinRoot' ? gen(6) : '' };
    const wellFormed = c.a.isWellFormed() && c.b.isWellFormed();
    // Only the filename rule may take a lone surrogate (its answer cannot change); the others refuse.
    const want = op === 'isPlainFilename' || wellFormed ? { value: JS_PATH[op](c.a, c.b) } : { error: 'input' };
    assert.deepEqual(wasmPath(c), want, `random path ${n}: ${JSON.stringify(c)}`);
  }
  console.log(`# storage differential: ${n}/${n} random pages and ${n}/${n} random paths agree`);
});
