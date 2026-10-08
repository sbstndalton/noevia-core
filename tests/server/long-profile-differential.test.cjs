'use strict';

// Shared fixtures for #1079: tests/fixtures/long-profile.v1.json (byte-identical to noevia-rs
// crates/long-profile/tests/fixtures/; CI compares them) replayed through dav-parse.wasm's
// long_profile. The expectations come from tools/gen-long-profile-fixtures.cjs's independent JS
// reference, so this is Rust against JS, case by case. The WebAssembly half needs
// server/wasm/dav-parse.wasm (or DAV_PARSE_WASM); skipped without it unless
// DAV_PARSE_WASM_REQUIRED=1.

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const davParseWasm = require('../../server/dav-parse-wasm.cjs');

const FILE = path.join(__dirname, '../fixtures/long-profile.v1.json');
const fixtures = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const wasmFile = process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM;
const skipWasm = !fs.existsSync(wasmFile) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built';

const GENERATOR = path.join(__dirname, '../../tools/gen-long-profile-fixtures.cjs');
// The shipped runtime image has no tools/ (CI mounts only tests/ there).
test('the fixture file is what the generator prints', { skip: !fs.existsSync(GENERATOR) && 'no generator here' }, () => {
  const out = execFileSync(process.execPath, [GENERATOR], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  assert.equal(out, fs.readFileSync(FILE, 'utf8'));
});

test('cases: wasm long_profile gives the reference reply for every case', { skip: skipWasm }, () => {
  davParseWasm.reset();
  assert.equal(fixtures.limits.maxInputBytes, davParseWasm.MAX_LONG_PROFILE_BYTES);
  assert.ok(fixtures.cases.length >= 90);
  const reasons = {};
  for (const c of fixtures.cases) {
    const got = davParseWasm.longProfileText(JSON.stringify(c.input));
    assert.deepEqual(got, c.expect, c.name);
    if (got.reason) reasons[got.reason] = (reasons[got.reason] || 0) + 1;
  }
  for (const r of ['invalid_id', 'is_long', 'ambiguous', 'no_base', 'exists', 'no_model', 'bad_path', 'high', 'low', 'no_long', 'is_long']) assert.ok(reasons[r] >= 1, r);
});

test('errors: wasm long_profile refuses what the reference refuses, with the same code', { skip: skipWasm }, () => {
  davParseWasm.reset();
  for (const e of fixtures.errors) {
    const text = e.text + ' '.repeat(e.pad);
    assert.throws(() => davParseWasm.longProfileText(text), err => err instanceof davParseWasm.DavParseError && err.reason === e.expect.error, e.name);
  }
});

test('the reply may be exactly 1 MiB; one byte more is refused, as is a text over 1 MiB', { skip: skipWasm }, () => {
  davParseWasm.reset();
  const max = fixtures.limits.maxFileBytes;
  // '[a]\nmodel = /f\n[b]\n; ' + k + '\n' (22 + k bytes) gains '\n[a-long]\nmodel = /f\n' (21).
  const padded = k => '[a]\nmodel = /f\n[b]\n; ' + 'p'.repeat(k) + '\n';
  const at = davParseWasm.longProfileSection({ text: padded(max - 43), base: 'a' });
  assert.equal(at.ok, true);
  assert.equal(Buffer.byteLength(at.text), max);
  assert.deepEqual(davParseWasm.longProfileSection({ text: padded(max - 42), base: 'a' }), { ok: false, reason: 'too_large' });
  assert.throws(() => davParseWasm.longProfileSection({ text: 'x'.repeat(max + 1), base: 'a' }), err => err.reason === 'too_large');
});

test('every added section reloads without unloading a loaded model (preset_reload agrees)', { skip: skipWasm }, () => {
  davParseWasm.reset();
  let checked = 0;
  for (const c of fixtures.cases) {
    if (c.input.op !== 'section' || !c.expect.ok) continue;
    const loaded = [...new Set(c.input.text.split(/\r\n|\n|\r/).map(l => /^\[([^\]]+)\]/.exec(l)?.[1]).filter(Boolean))];
    if (!loaded.length || loaded.length > 64) continue;
    const verdict = davParseWasm.presetReload({ baseline: c.input.text, current: c.expect.text, loaded });
    assert.equal(verdict.safe, true, c.name);
    checked++;
  }
  assert.ok(checked >= 20, String(checked));
});

test('the loader checks the reply against the request', { skip: skipWasm }, () => {
  davParseWasm.reset();
  assert.deepEqual(davParseWasm.longProfilePairs([{ id: 'a', model: '/f' }, { id: 'a-long', model: '/f' }, { id: 'b-long', model: '/f' }]), [{ base: 'a', long: 'a-long' }]);
  assert.deepEqual(davParseWasm.longProfilePick({ model: 'a', profile: 'high', pairs: [{ base: 'a', long: 'a-long' }] }), { model: 'a-long', long: true, reason: 'high' });
  assert.throws(() => davParseWasm.longProfileText(5), err => err.reason === 'input');
  assert.throws(() => davParseWasm.longProfilePairs('rows'), err => err.reason === 'input');
});
