'use strict';

// Project file names (PROJECT_FILE_NAMES_IMPL, retired in #1071: always Rust).
// tests/fixtures/project-file-names.v1.json (byte-identical to noevia-rs
// crates/project-file-names/tests/fixtures/; CI compares them) holds the port's wire answers for
// synthetic names, first printed from the former JS resolver. tests/fixtures/project-file-names-resolver.v1.json
// freezes what that JS resolver answered for the same rows and for the seeded projects below (the
// resolved file, or the code and the model-readable error). Both files are frozen: the JS resolver
// and its generator are gone, and neither may be regenerated through the Rust path (that would erase
// the independent reference). Here every row runs through dav-parse.wasm's project_file_names and the
// resolver: where the port answers, the resolver gives the frozen JS answer; where the port refuses,
// the resolver gives 'unverified' (before #1071 a JS answer of "missing" or "ambiguous" stood there:
// the intended change, counted below). Seeded live projects with non-ASCII names check that the
// port agrees with the frozen answers or refuses (never another file). The port's NFC-inert table
// is checked exhaustively against this runtime's own normalize(), so the shortcut holds on the
// shipped ICU too; so is its base + combining-mark composition table (noevia#1211). The WebAssembly
// half needs server/wasm/dav-parse.wasm (or DAV_PARSE_WASM); skipped without it unless
// DAV_PARSE_WASM_REQUIRED=1.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const davParseWasm = require('../../server/dav-parse-wasm.cjs');
const pf = require('../../server/project-file-names.cjs');

const FILE = path.join(__dirname, '../fixtures/project-file-names.v1.json');
const FROZEN = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/project-file-names-resolver.v1.json'), 'utf8'));
const fixtures = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const wasmFile = process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM;
const skipWasm = !fs.existsSync(wasmFile) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built';

// project_file_names::NFC_INERT_RANGES
const INERT = [[0x0000, 0x02ff], [0x0400, 0x0482], [0x048a, 0x04ff], [0x2010, 0x2027], [0x2030, 0x205e], [0x3001, 0x3029],
  [0x3041, 0x3096], [0x30a1, 0x30fc], [0x4e00, 0x9fff], [0xac00, 0xd7a3], [0xff01, 0xff60], [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff],
  [0x1f900, 0x1f9ff], [0x1fa70, 0x1faff]];

function quietly(fn) {
  const warn = console.warn;
  console.warn = () => {};
  try { return fn(); } finally { console.warn = warn; }
}

test('the fixture files are frozen: they line up and no JS resolver, validator or generator remains', () => {
  assert.equal(FROZEN.version, 1);
  assert.equal(FROZEN.rows.length, fixtures.rows.length);
  assert.equal(FROZEN.seeded.length, 3000);
  assert.deepEqual(Object.keys(pf), ['resolveProjectFile']);
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
  assert.ok(checked > 34_000, `${checked}`);
});

test('every base + mark composition the port reads is one NFC-inert code point, stable across inert neighbours (noevia#1211)', () => {
  let pairs = 0;
  for (let base = 0; base < 0x300; base++) {
    for (let mark = 0x300; mark < 0x370; mark++) {
      const nfc = [...String.fromCharCode(base, mark).normalize('NFC')];
      if (nfc.length !== 1 || nfc[0].codePointAt(0) >= 0x300) continue;
      pairs++;
      // NFC of (inert) + pair + (inert) is the parts' NFC: the crate's compose_pairs argument.
      for (const [x, y] of [['a', '.md'], ['\u00e9', '\u65e5'], ['\u0430', '\ud83d\ude00'], ['', '']]) {
        const s = `${x}${String.fromCharCode(base, mark)}${y}`;
        assert.equal(s.normalize('NFC'), `${x}${nfc[0]}${y}`, `U+${base.toString(16)} U+${mark.toString(16)}`);
      }
    }
  }
  assert.ok(pairs >= 300, `${pairs}`);
});

test('the port composes exactly the runtime\u2019s base + mark pairs, and refuses every other one (noevia#1211)', { skip: skipWasm }, () => {
  let composed = 0, refused = 0;
  for (let base = 0; base < 0x300; base++) {
    for (let mark = 0x300; mark < 0x370; mark++) {
      for (const raw of [`a${String.fromCharCode(base, mark)}.md`, `a${String.fromCharCode(base, mark)}`]) {
        const nfc = raw.normalize('NFC');
        const pair = [...String.fromCharCode(base, mark).normalize('NFC')];
        let port = null;
        try { port = davParseWasm.projectFileNames([nfc], raw); } catch (e) { assert.equal(e.reason, 'ambiguous'); }
        if (port && port.code === 'invalid') continue; // a control character, separator or the like: not a name at all
        if (pair.length === 1 && pair[0].codePointAt(0) < 0x300) {
          assert.deepEqual(port, { file: 0 }, `U+${base.toString(16)} U+${mark.toString(16)}`);
          composed++;
        } else {
          assert.equal(port, null, `U+${base.toString(16)} U+${mark.toString(16)}`);
          refused++;
        }
      }
    }
  }
  assert.ok(composed >= 500 && refused > 100_000, `${composed} composed, ${refused} refused`);
});

test('fixture rows: the port answers as the fixture says; the resolver gives the frozen JS answer, or unverified where the port refuses', { skip: skipWasm }, () => {
  assert.ok(fixtures.rows.length >= 500);
  const changed = { missing: 0, ambiguous: 0, file: 0 };
  for (const [i, row] of fixtures.rows.entries()) {
    const [names, raw] = JSON.parse(row.wire);
    const files = names.map((name) => ({ name }));
    const frozen = FROZEN.rows[i];
    const got = quietly(() => pf.resolveProjectFile({ files }, raw));
    if (row.want !== undefined) {
      assert.deepEqual(davParseWasm.projectFileNames(names, raw), JSON.parse(row.want), `row ${i}`);
      const resolved = got.file ? { file: files.indexOf(got.file) } : got;
      assert.deepEqual(resolved, frozen, `row ${i} resolver`);
    } else {
      assert.throws(() => davParseWasm.projectFileNames(names, raw), (e) => e instanceof davParseWasm.DavParseError && e.reason === row.refused, `row ${i}`);
      assert.ok(!got.file && got.code === 'unverified', `row ${i} resolver`);
      changed[frozen.file !== undefined ? 'file' : frozen.code === 'missing' || frozen.code === 'ambiguous' ? frozen.code : 'other'] += 1;
    }
  }
  // Where the port cannot decide: a JS file stayed unverified before too (43 rows); a JS "missing" or
  // "ambiguous" is now unverified as well (27 and 4 rows): the one change of #1071.
  assert.deepEqual(changed, { missing: 27, ambiguous: 4, file: 43 });
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

test('seeded live projects: the port gives the frozen JS answer or refuses, and the resolver never resolves another file', { skip: skipWasm }, () => {
  const rand = mulberry32(0xf00d);
  const pick = (l) => l[Math.floor(rand() * l.length)];
  const name = () => Array.from({ length: 1 + Math.floor(rand() * 3) }, () => pick(SEG)).join('/') + pick(['.md', '']);
  let agreed = 0, refused = 0;
  const short = (r) => (r.file !== undefined ? `f${r.file}` : r.code === 'ambiguous' ? `a${r.candidates.join(',')}` : r.code === 'missing' ? 'm' : 'i');
  for (let n = 0; n < 3000; n++) {
    const names = Array.from({ length: Math.floor(rand() * 6) }, name);
    const raw = names.length && rand() < 0.6 ? pick(names).split('/').slice(Math.floor(rand() * 2)).join('/') : name();
    const files = names.map((nm) => ({ name: nm }));
    const frozen = FROZEN.seeded[n], where = JSON.stringify([names, raw]);
    let port = null;
    try { port = davParseWasm.projectFileNames(names, raw); } catch (e) { assert.equal(e.reason, 'ambiguous'); refused++; }
    if (port) {
      agreed++;
      assert.equal(short(port), frozen, where);
    }
    const got = quietly(() => pf.resolveProjectFile({ files }, raw));
    if (got.file) assert.equal(`f${files.indexOf(got.file)}`, frozen, where);
    else if (port) assert.equal(got.code === 'invalid' ? 'i' : got.code === 'missing' ? 'm' : `a${got.candidates.map((c) => names.indexOf(c)).join(',')}`, frozen, where);
    else assert.equal(got.code, 'unverified', where);
  }
  assert.ok(agreed > 1000 && refused > 100, `${agreed} agreed, ${refused} refused`);
});
