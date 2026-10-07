'use strict';

// Shared fixtures for #1062: tests/fixtures/tune-contention.v1.json (byte-identical to noevia-rs
// crates/tune-contention/tests/fixtures/; CI compares them) replayed through dav-parse.wasm's
// tune_contention. The expectations come from tools/gen-tune-contention-fixtures.cjs's independent
// JS reference, so this is Rust against JS, case by case. The WebAssembly half needs
// server/wasm/dav-parse.wasm (or DAV_PARSE_WASM); skipped without it unless
// DAV_PARSE_WASM_REQUIRED=1.

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const davParseWasm = require('../../server/dav-parse-wasm.cjs');

const FILE = path.join(__dirname, '../fixtures/tune-contention.v1.json');
const fixtures = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const wasmFile = process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM;
const skipWasm = !fs.existsSync(wasmFile) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built';

const GENERATOR = path.join(__dirname, '../../tools/gen-tune-contention-fixtures.cjs');
// The shipped runtime image has no tools/ (CI mounts only tests/ there).
test('the fixture file is what the generator prints', { skip: !fs.existsSync(GENERATOR) && 'no generator here' }, () => {
  const out = execFileSync(process.execPath, [GENERATOR], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  assert.equal(out, fs.readFileSync(FILE, 'utf8'));
});

test('cases: wasm tune_contention gives the reference decision for every case', { skip: skipWasm }, () => {
  davParseWasm.reset();
  assert.equal(fixtures.limits.maxInputBytes, davParseWasm.MAX_CONTENTION_BYTES);
  assert.ok(fixtures.cases.length >= 250);
  const reasons = {};
  for (const c of fixtures.cases) {
    const got = davParseWasm.tuneContention(c.input);
    assert.deepEqual(got, c.expect, c.name);
    reasons[got.reason] = (reasons[got.reason] || 0) + 1;
  }
  for (const r of ['clear', 'timed_out', 'loading', 'other', 'busy', 'settling', 'idle', 'idle_unknown']) assert.ok(reasons[r] >= 3, r);
});

test('errors: wasm tune_contention refuses what the reference refuses, with the same code', { skip: skipWasm }, () => {
  davParseWasm.reset();
  for (const e of fixtures.errors) {
    const text = e.text + ' '.repeat(e.pad);
    assert.throws(() => davParseWasm.tuneContentionText(text), err => err instanceof davParseWasm.DavParseError && err.reason === e.expect.error, e.name);
  }
});

test('the loader refuses a reply that breaks the contract', { skip: skipWasm }, () => {
  // A well-formed request still gets a checked reply: unload names only foreign ids.
  davParseWasm.reset();
  const r = davParseWasm.tuneContention({ tuning: 't', rows: [{ id: 'q', status: 'loaded', busy: 0 }], prev: null, startedAt: 0, now: 0, maxWaitMs: 10, quietMs: 0 });
  assert.deepEqual(r, { action: 'unload', reason: 'idle', foreign: ['q'], unload: ['q'], fingerprint: '[["q","idle"]]', since: 0, waitedMs: 0 });
  assert.throws(() => davParseWasm.tuneContentionText(5), err => err.reason === 'input');
});
