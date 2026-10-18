'use strict';
// #1208 and #1209 for the Rust port, which is the only implementation since #1071 (these were switch tests
// against the JS before): a percent-encoded or decomposed spelling of the Diary folder is refused, and long
// path arguments are refused without work proportional to their length. The port knows no Unicode tables beyond
// its NFC-inert set and one base-plus-mark composition table, so a folder or path outside them cannot be compared
// and is refused as "the Diary folder could not be identified" (fail closed). Synthetic folder and provider only.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs');
const davParseWasm = require('./dav-parse-wasm.cjs');
const pe = require('./provider-egress.cjs');

const wasmFile = process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM;
const skip = !fs.existsSync(wasmFile) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built';
const REMOTE = { id: 'r', external: true, label: 'Remote', baseUrl: 'https://remote.example/v1' };
const STORAGE = { kind: 'nextcloud', corpusRoot: 'Diary', baseUrl: 'https://nc.example/remote.php/dav/files/alice', password: 'synthetic' };
const refusal = (path, storage = STORAGE) => pe.toolRefusal({ provider: REMOTE, toolName: 'nc_webdav_read_file', rawArgs: JSON.stringify({ path }), storage });

test('#1208: every spelling of a non-ASCII Diary folder is refused; a folder the port cannot compare closes storage', { skip }, () => {
  const storage = { ...STORAGE, corpusRoot: 'Tagebücher' };
  // Composed, percent-encoded, decomposed (the port composes a base letter and one combining mark), upper case.
  for (const path of ['Tageb%C3%BCcher/x.md', 'TAGEB%C3%9CCHER', 'Tagebu%CC%88cher/x.md', 'Tagebücher/x.md', 'TAGEBU%CC%88CHER']) {
    assert.match(refusal(path, storage), /in the Diary folder/, path);
  }
  assert.equal(refusal('Work/a.md', storage), null);
  // A folder outside the port's table (Greek letters) cannot be compared: storage is closed, fail closed.
  const unknown = { ...STORAGE, corpusRoot: 'Ημερολόγιο' };
  for (const path of ['Work/a.md', 'Ημερολόγιο/x']) {
    assert.match(refusal(path, unknown), /^ERROR: nc_webdav_read_file is not available with Remote: the Diary folder could not be identified/, path);
  }
});

test('#1209: long path arguments are refused before any per-character work, and a long run of dots is cheap', { skip }, () => {
  const t0 = process.hrtime.bigint();
  const long = `${'/remote.php/webdav/x'.repeat(50_000)}\n`;
  assert.match(refusal(long), /in the Diary folder/);
  assert.equal(refusal('W'.repeat(4096)), null);
  assert.match(refusal('W'.repeat(4097)), /in the Diary folder/);
  const dots = { baseUrl: `http://a${'.'.repeat(320_000)}b/` };
  assert.equal(pe.isExternalProvider(dots), false);
  assert.ok(Number(process.hrtime.bigint() - t0) / 1e9 < 2, 'bounded');
});
