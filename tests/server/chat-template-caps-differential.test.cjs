'use strict';

// Shared fixtures for #1002/#1003: tests/fixtures/chat-template-caps.v1.json (byte-identical to
// noevia-rs crates/chat-template-caps/tests/fixtures/; CI compares them) through dav-parse.wasm's
// template_caps, provider_error and serving_verdict, and the JS context test (chat-context.cjs
// providerErrorJs) against its recorded answers plus seeded random text, Rust and JS side by
// side. The file is what tools/gen-chat-template-caps-fixtures.cjs prints. The WebAssembly half
// needs server/wasm/dav-parse.wasm (or DAV_PARSE_WASM); skipped without it unless
// DAV_PARSE_WASM_REQUIRED=1.

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const davParseWasm = require('../../server/dav-parse-wasm.cjs');
const { providerErrorJs, CONTEXT_FULL_TEXT } = require('../../server/chat-context.cjs');

const FILE = path.join(__dirname, '../fixtures/chat-template-caps.v1.json');
const fixtures = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const wasmFile = process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM;
const skipWasm = !fs.existsSync(wasmFile) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built';

const GENERATOR = path.join(__dirname, '../../tools/gen-chat-template-caps-fixtures.cjs');
// The shipped runtime image has no tools/ (CI mounts only tests/ there).
test('the fixture file is what the generator prints', { skip: !fs.existsSync(GENERATOR) && 'no generator here' }, () => {
  const out = execFileSync(process.execPath, [GENERATOR], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(out, fs.readFileSync(FILE, 'utf8'));
});

test('the JS context test gives the recorded answers', () => {
  for (const c of fixtures.context) assert.equal(providerErrorJs(c.text) === CONTEXT_FULL_TEXT, c.jsContextFull, JSON.stringify(c.text));
});

test('templates: wasm template_caps gives the expected capabilities', { skip: skipWasm }, () => {
  davParseWasm.reset();
  assert.ok(fixtures.templates.length >= 20);
  for (const c of fixtures.templates) assert.deepEqual(davParseWasm.templateCaps(c.template), c.expect, c.name);
  assert.throws(() => davParseWasm.templateCaps('x'.repeat(davParseWasm.MAX_TEMPLATE_BYTES + 1)), (e) => e.reason === 'too_large');
});

test('errors and verdicts: wasm provider_error and serving_verdict', { skip: skipWasm }, () => {
  davParseWasm.reset();
  for (const c of fixtures.errors) {
    const got = davParseWasm.providerErrorKind(c.status, c.body);
    assert.equal(got.kind, c.expect.kind, c.name);
    if ('reason' in c.expect) assert.equal(got.reason, c.expect.reason, c.name);
    assert.ok([...got.reason].length <= fixtures.limits.maxReasonChars);
  }
  for (const c of fixtures.verdicts) {
    const v = davParseWasm.servingVerdict(c.status, c.body);
    assert.deepEqual({ passed: v.passed, kind: v.kind }, c.expect, c.name);
  }
});

test('context: Rust and JS agree on recorded and seeded random text', { skip: skipWasm }, () => {
  davParseWasm.reset();
  let seed = 0x1003;
  const rand = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 32; };
  const alphabet = ['c', 'o', 'n', 't', 'e', 'x', 'C', 'O', 'N', 'T', 'E', 'X', 'context', 'exceed', 'full', 'length', 'maximum ', 'too many tokens', '\n', '\r', ' ', 'ı', 'K', ' ', 'ü', '\ud800', '{"error":"', '"}'];
  const texts = fixtures.context.map((c) => c.text);
  for (let i = 0; i < 500; i++) { let s = ''; const n = Math.floor(rand() * 12); for (let j = 0; j < n; j++) s += alphabet[Math.floor(rand() * alphabet.length)]; texts.push(s); }
  for (const text of texts) {
    // A lone surrogate crosses as U+FFFD (toWellFormed); neither can match an ASCII marker.
    assert.equal(davParseWasm.providerErrorKind(400, text).kind === 'context_full', providerErrorJs(text) === CONTEXT_FULL_TEXT, JSON.stringify(text));
  }
});
