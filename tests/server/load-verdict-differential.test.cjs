'use strict';

// Shared fixtures for #1004: tests/fixtures/load-verdict.v1.json (byte-identical to noevia-rs
// crates/load-verdict/tests/fixtures/; CI compares them) replayed through dav-parse.wasm's
// load_verdict. The expectations come from tools/gen-load-verdict-fixtures.cjs's independent JS
// reference, so this is Rust against JS, case by case. The WebAssembly half needs
// server/wasm/dav-parse.wasm (or DAV_PARSE_WASM); skipped without it unless
// DAV_PARSE_WASM_REQUIRED=1.

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const davParseWasm = require('../../server/dav-parse-wasm.cjs');

const FILE = path.join(__dirname, '../fixtures/load-verdict.v1.json');
const fixtures = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const wasmFile = process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM;
const skipWasm = !fs.existsSync(wasmFile) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built';

const GENERATOR = path.join(__dirname, '../../tools/gen-load-verdict-fixtures.cjs');
// The shipped runtime image has no tools/ (CI mounts only tests/ there).
test('the fixture file is what the generator prints', { skip: !fs.existsSync(GENERATOR) && 'no generator here' }, () => {
  const out = execFileSync(process.execPath, [GENERATOR], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  assert.equal(out, fs.readFileSync(FILE, 'utf8'));
});

test('cases: wasm load_verdict gives the reference verdict for every case', { skip: skipWasm }, () => {
  davParseWasm.reset();
  assert.equal(fixtures.limits.maxInputBytes, davParseWasm.MAX_VERDICT_BYTES);
  assert.ok(fixtures.cases.length >= 250);
  const sources = {};
  for (const c of fixtures.cases) {
    const got = davParseWasm.loadVerdict(c.input);
    assert.deepEqual(got, c.expect, c.name);
    sources[got.source] = (sources[got.source] || 0) + 1;
  }
  for (const s of ['measured', 'rule', 'advisor', 'fallback']) assert.ok(sources[s] >= 5, s);
});

test('errors: wasm load_verdict refuses what the reference refuses, with the same code', { skip: skipWasm }, () => {
  davParseWasm.reset();
  for (const e of fixtures.errors) {
    const text = e.text + ' '.repeat(e.pad);
    assert.throws(() => davParseWasm.loadVerdictText(text), err => err instanceof davParseWasm.DavParseError && err.reason === e.expect.error, e.name);
  }
});
