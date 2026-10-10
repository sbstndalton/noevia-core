'use strict';

// LLAMACPP_PRESETS_IMPL: tests/fixtures/llamacpp-presets.v1.json (byte-identical to noevia-rs
// crates/llamacpp-presets/tests/fixtures/; CI compares them) holds llamacpp-presets.cjs's answers,
// printed by tools/gen-llamacpp-presets-fixtures.cjs from the JS itself (synthetic values only).
// Here every row runs through dav-parse.wasm's llamacpp_presets; seeded properties check that the
// port never accepts an option, a value, a model name or a micro-batch the JS refuses (and,
// agreeing, gives the JS's exact value), also through the whole switched prepare(); every UTF-16
// code unit is checked against this runtime's own String#trim and Number(); and a large request
// stays fast. The WebAssembly half needs server/wasm/dav-parse.wasm (or DAV_PARSE_WASM); skipped
// without it unless DAV_PARSE_WASM_REQUIRED=1.

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const davParseWasm = require('../../server/dav-parse-wasm.cjs');
const presets = require('../../server/llamacpp-presets.cjs');

const FILE = path.join(__dirname, '../fixtures/llamacpp-presets.v1.json');
const GENERATOR = path.join(__dirname, '../../tools/gen-llamacpp-presets-fixtures.cjs');
const fixtures = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const wasmFile = process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM;
const skipWasm = !fs.existsSync(wasmFile) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built';
const LIMITS = { capMib: 1024, hardMaxMib: 2048 };

function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function quietly(fn) {
  const warn = console.warn, seen = [];
  console.warn = (m) => seen.push(String(m));
  try { return { value: fn(), seen }; } finally { console.warn = warn; }
}

const CALLS = {
  1: ([pairs, hard]) => davParseWasm.llamacppPresetsValues(pairs, hard),
  2: ([pairs]) => davParseWasm.llamacppPresetsCanonical(pairs),
  3: ([u, b]) => davParseWasm.llamacppPresetsBatch(u, b),
  4: ([m]) => davParseWasm.llamacppPresetsModel(m),
};

test('the fixture file is what the generator prints', { skip: !fs.existsSync(GENERATOR) && 'no generator here' }, () => {
  const out = execFileSync(process.execPath, [GENERATOR], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  assert.equal(out, fs.readFileSync(FILE, 'utf8'));
});

test('fixture rows: the exact reply; strict rows only ever refuse more than the JS', { skip: skipWasm }, () => {
  assert.ok(fixtures.rows.length >= 11000);
  let strict = 0;
  for (const [i, row] of fixtures.rows.entries()) {
    const args = JSON.parse(row.wire), want = JSON.parse(row.want);
    assert.deepEqual(CALLS[row.op](args), want, `row ${i}`);
    if (row.op === 1 && !row.strict) {
      // Not strict: the reply is the JS's own answer, recomputed here from the module.
      const [pairs, hard] = args;
      assert.deepEqual(want.values, pairs.map(([k, v]) => presets.optionValue(k, v, { capMib: 1024, hardMaxMib: hard }) ?? null), `row ${i}`);
    }
    if (row.op === 3 && !row.strict) assert.equal(want.exceeds, presets.microBatchExceeds(args[0] ?? undefined, args[1] ?? undefined), `row ${i}`);
    if (row.op === 4) assert.equal(want.ok, presets.modelNameOk(args[0]), `row ${i}`);
    if (row.strict) {
      strict++;
      assert.ok(row.op === 1 || row.op === 3, `row ${i}: only values and the micro-batch check are stricter`);
      if (row.op === 3) assert.equal(want.exceeds, null);
    }
  }
  assert.ok(strict > 200, `${strict} strict rows`);
});

const ALPHABET = ['0', '1', '2', '4', '5', '8', '9', '.', '+', '-', 'e', 'E', 'x', 'X', 'o', 'b', 'f', 'a', 'u', 't', 'l', 'n', 'q', '_', ',', ' ', '\t', '\n',
  ' ', ' ', '　', '﻿', '᠎', '​', '٠', '１', 'Infinity', 'NaN', '\ud800'];
function randomText(rand, max) {
  let s = '';
  const n = Math.floor(rand() * max);
  for (let i = 0; i < n; i++) s += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  return s;
}

test('property: the port never accepts a value or micro-batch the JS refuses, and agrees exactly otherwise', { skip: skipWasm }, () => {
  const rand = mulberry32(0x5eed1132);
  const names = Object.keys(presets.fields), aliases = Object.values(presets.fields).flatMap((f) => f.aliases);
  for (let round = 0; round < 40; round++) {
    const pairs = [];
    for (let i = 0; i < 200; i++) pairs.push([rand() < 0.8 ? names[Math.floor(rand() * names.length)] : aliases[Math.floor(rand() * aliases.length)], randomText(rand, 10)]);
    const hard = [2048, 1024, 1048576, 0][round % 4];
    const { values } = davParseWasm.llamacppPresetsValues(pairs, hard);
    for (const [i, [k, v]] of pairs.entries()) {
      const js = presets.optionValue(k, v, { capMib: 1024, hardMaxMib: hard }) ?? null;
      assert.equal(values[i], js, `${k} = ${JSON.stringify(v)}`);
    }
    const nums = [];
    for (let i = 0; i < 200; i++) nums.push([rand() < 0.1 ? null : randomText(rand, 8), rand() < 0.1 ? null : randomText(rand, 8)]);
    for (const [u, b] of nums) {
      const port = davParseWasm.llamacppPresetsBatch(u, b).exceeds, js = presets.microBatchExceeds(u ?? undefined, b ?? undefined);
      // Undecided (null) only for a 0x/0o/0b literal wider than 53 bits; never a pass the JS fails.
      if (port === null) assert.match(`${u}|${b}`, /0[xXoObB]/);
      else assert.equal(port, js, `${JSON.stringify(u)} > ${JSON.stringify(b)}`);
    }
    const raw = [];
    for (let i = 0; i < 100; i++) raw.push([randomText(rand, 3) + (rand() < 0.5 ? '-'.repeat(Math.floor(rand() * 3)) : '') + (rand() < 0.6 ? pick(rand, [...names, ...aliases]) : randomText(rand, 6)) + randomText(rand, 2), rand() < 0.1 ? null : randomText(rand, 8)]);
    const { options } = davParseWasm.llamacppPresetsCanonical(raw);
    for (const [i, [k, v]] of raw.entries()) assert.deepEqual(options[i], presets.canonicalEntry(k, v), JSON.stringify(k));
  }
});
function pick(rand, list) { return list[Math.floor(rand() * list.length)]; }

test('property: the switched prepare() never writes what the JS refuses, and writes the same text otherwise', { skip: skipWasm }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'presets-diff-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'models.ini');
  fs.writeFileSync(file, '[*]\nbatch-size = 2048\n\n[synthetic]\nmodel = /models/synthetic.gguf\nub = 512\n');
  const js = presets.createPresetStore(file, { cacheRam: LIMITS, env: {} });
  const sw = presets.createPresetStore(file, { cacheRam: LIMITS, env: { LLAMACPP_PRESETS_IMPL: 'wasm' } });
  const rand = mulberry32(0x9e3779b9);
  const names = Object.keys(presets.fields);
  const VALUES = ['', '64', '512', '4096', '8192', '9000', '0x40', '1e3', ' 64', '0.5', '2.000', '2.001', 'auto', 'q8_0', '-1', '99999999', '00032', ' 256', '5\n'];
  const revision = js.get('synthetic').revision;
  for (let n = 0; n < 1500; n++) {
    const options = {};
    const count = 1 + Math.floor(rand() * 3);
    for (let i = 0; i < count; i++) options[rand() < 0.9 ? pick(rand, names) : pick(rand, ['c', 'model', 'cram', '__proto__x'])] = rand() < 0.7 ? pick(rand, VALUES) : randomText(rand, 6);
    const model = rand() < 0.9 ? 'synthetic' : pick(rand, ['other', 'a b', '', 'x'.repeat(201)]);
    const run = (store) => { try { return { text: store.prepare({ model, baseRevision: revision, options }).text }; } catch (e) { return { status: e.status, message: e.message }; } };
    const a = run(js), b = quietly(() => run(sw)).value;
    if (a.text === undefined) assert.equal(b.text, undefined, `the switch accepted what the JS refused: ${JSON.stringify(options)}`);
    else assert.deepEqual(b, a, JSON.stringify(options));
  }
});

test('every UTF-16 code unit: String#trim and Number() white space read as this runtime reads them', { skip: skipWasm }, () => {
  const pairs = [], nums = [];
  for (let c = 0; c <= 0xffff; c++) {
    const ch = String.fromCharCode(c);
    pairs.push([`${ch}--c${ch}`, `${ch}5${ch}`]);
    nums.push(`${ch}64${ch}`);
  }
  const { options } = davParseWasm.llamacppPresetsCanonical(pairs);
  for (const [i, p] of pairs.entries()) assert.deepEqual(options[i], presets.canonicalEntry(...p), `U+${i.toString(16)}`);
  for (const [i, s] of nums.entries()) {
    // 64 > 63 exactly when Number() strips this code unit; NaN otherwise.
    assert.equal(davParseWasm.llamacppPresetsBatch(s, '63').exceeds, presets.microBatchExceeds(s, '63'), `U+${i.toString(16)}`);
  }
  const { values } = davParseWasm.llamacppPresetsValues(pairs.map(([, v]) => ['cache-ram', v]), 2048);
  for (const [i, [, v]] of pairs.entries()) assert.equal(values[i], presets.optionValue('cache-ram', v, LIMITS) ?? null, `U+${i.toString(16)}`);
});

test('a request near the cap is answered quickly, and one past it is refused (the caller then refuses)', { skip: skipWasm }, () => {
  const long = '9'.repeat(3 * 1024 * 1024);
  const start = Date.now();
  assert.equal(davParseWasm.llamacppPresetsBatch(long, '0x' + '0'.repeat(500000) + '40').exceeds, true);
  assert.deepEqual(davParseWasm.llamacppPresetsValues([['cache-ram', long]], 2048).values, ['2048']);
  assert.ok(Date.now() - start < 10_000);
  assert.throws(() => davParseWasm.llamacppPresetsValues([['ctx-size', '1'.repeat(davParseWasm.MAX_LLAMACPP_PRESETS_BYTES)]], 2048), { name: 'DavParseError' });
});
