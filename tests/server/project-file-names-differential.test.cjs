'use strict';

// PROJECT_FILE_NAMES_IMPL: tests/fixtures/project-file-names.v1.json (byte-identical to noevia-rs
// crates/project-file-names/tests/fixtures/; CI compares them) holds resolveProjectFile's answers,
// printed by tools/gen-project-file-names-fixtures.cjs from the JS itself (synthetic names only).
// Here every row runs through dav-parse.wasm's project_file_names and the switched resolver; seeded
// live projects with non-ASCII names check that the port agrees or refuses (never another file) and
// that the switched resolver never resolves what the JS does not. The port's NFC-inert table is
// checked exhaustively against this runtime's own normalize(), so the shortcut holds on the shipped
// ICU too. The WebAssembly half needs server/wasm/dav-parse.wasm (or DAV_PARSE_WASM); skipped
// without it unless DAV_PARSE_WASM_REQUIRED=1.

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const davParseWasm = require('../../server/dav-parse-wasm.cjs');
const pf = require('../../server/project-file-names.cjs');

const FILE = path.join(__dirname, '../fixtures/project-file-names.v1.json');
const GENERATOR = path.join(__dirname, '../../tools/gen-project-file-names-fixtures.cjs');
const fixtures = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const wasmFile = process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM;
const skipWasm = !fs.existsSync(wasmFile) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built';
const WASM = { impl: 'wasm' };

// project_file_names::NFC_INERT_RANGES
const INERT = [[0x0000, 0x02ff], [0x0400, 0x0482], [0x048a, 0x04ff], [0x3041, 0x3096], [0x30a1, 0x30fa], [0x4e00, 0x9fff], [0xac00, 0xd7a3]];

function quietly(fn) {
  const warn = console.warn;
  console.warn = () => {};
  try { return fn(); } finally { console.warn = warn; }
}

test('the fixture file is what the generator prints', { skip: !fs.existsSync(GENERATOR) && 'no generator here' }, () => {
  const out = execFileSync(process.execPath, [GENERATOR], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  assert.equal(out, fs.readFileSync(FILE, 'utf8'));
});

test('every NFC-inert code point is its own NFC form, has class 0 and never composes with what precedes it', () => {
  // Every code point that appears after the first position of a canonical decomposition (a
  // possible second half of a composition), from the runtime's own tables.
  const secondaries = new Set();
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const d = [...String.fromCodePoint(cp).normalize('NFD')];
    for (let k = 1; k < d.length; k++) secondaries.add(d[k].codePointAt(0));
  }
  let checked = 0;
  for (const [a, b] of INERT) {
    for (let cp = a; cp <= b; cp++) {
      const c = String.fromCodePoint(cp);
      assert.equal(c.normalize('NFC'), c, `U+${cp.toString(16)} is not NFC`);
      assert.ok(!secondaries.has(cp), `U+${cp.toString(16)} can compose with a preceding character`);
      assert.ok(!secondaries.has(c.normalize('NFD').codePointAt(0)), `U+${cp.toString(16)} decomposes to a composing start`);
      // Class 0: no reordering against a class-240 mark before it or a class-230 mark after it.
      assert.ok(`\u0345${c}`.normalize('NFD').startsWith('\u0345'), `U+${cp.toString(16)} reorders before U+0345`);
      assert.ok(`${c}\u0300`.normalize('NFD').endsWith('\u0300'), `U+${cp.toString(16)} reorders after U+0300`);
      checked++;
    }
  }
  assert.ok(checked > 33_000, `${checked}`);
});

test('fixture rows: the same file, reason, candidates or refusal; the switched resolver agrees or refuses', { skip: skipWasm }, () => {
  assert.ok(fixtures.rows.length >= 500);
  for (const [i, row] of fixtures.rows.entries()) {
    const [names, raw] = JSON.parse(row.wire);
    const files = names.map((name) => ({ name }));
    const js = pf.resolveProjectFileJs({ files }, raw);
    const switched = quietly(() => pf.resolveProjectFile({ files }, raw, WASM));
    if (row.want !== undefined) {
      assert.deepEqual(davParseWasm.projectFileNames(names, raw), JSON.parse(row.want), `row ${i}`);
      assert.deepEqual(switched, js, `row ${i} switched`);
    } else {
      assert.throws(() => davParseWasm.projectFileNames(names, raw), (e) => e instanceof davParseWasm.DavParseError && e.reason === row.refused, `row ${i}`);
      assert.ok(!switched.file && (switched.code === 'unverified' || switched.code === js.code), `row ${i} switched`);
    }
  }
});

function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const SEG = ['a', 'notes', 'Text', '\u65e5\u672c', 'caf\u00e9', 'cafe\u0301', '\u03b1\u03b2', '\u05e9\u05dc\u05d5\u05dd', '\u0928\u092e',
  '\ud55c\uae00', '\u1100\u1161', '\u304b\u3099', '\ufb01le', '\u212b', '\ud83d\ude00', 'x\ud800', '..', '', '%2e', ' '];

test('seeded live projects: never another file, and the switched resolver never resolves what the JS does not', { skip: skipWasm }, () => {
  const rand = mulberry32(0xf00d);
  const pick = (l) => l[Math.floor(rand() * l.length)];
  const name = () => Array.from({ length: 1 + Math.floor(rand() * 3) }, () => pick(SEG)).join('/') + pick(['.md', '']);
  let agreed = 0, refused = 0;
  for (let n = 0; n < 3000; n++) {
    const names = Array.from({ length: Math.floor(rand() * 6) }, name);
    const raw = names.length && rand() < 0.6 ? pick(names).split('/').slice(Math.floor(rand() * 2)).join('/') : name();
    const files = names.map((nm) => ({ name: nm }));
    const js = pf.resolveProjectFileJs({ files }, raw);
    let port = null;
    try { port = davParseWasm.projectFileNames(names, raw); } catch (e) { assert.equal(e.reason, 'ambiguous'); refused++; }
    if (port) {
      agreed++;
      if (js.file) assert.equal(port.file, files.indexOf(js.file), JSON.stringify([names, raw]));
      else assert.equal(port.code, js.code, JSON.stringify([names, raw]));
    }
    const switched = quietly(() => pf.resolveProjectFile({ files }, raw, WASM));
    if (switched.file) assert.equal(switched.file, js.file);
    else assert.ok(!js.file || switched.code === 'unverified');
  }
  assert.ok(agreed > 1000 && refused > 100, `${agreed} agreed, ${refused} refused`);
});
