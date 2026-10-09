'use strict';

// PROVIDER_EGRESS_IMPL: tests/fixtures/provider-egress.v1.json (byte-identical to noevia-rs
// crates/provider-egress/tests/fixtures/; CI compares them) holds provider-egress.cjs's answers,
// printed by tools/gen-provider-egress-fixtures.cjs from the JS itself (synthetic rows only). Here
// every row runs through dav-parse.wasm's provider_egress and the switched functions; seeded live
// tool calls, providers and toolbox selections check that the switched rules never let out more
// than the JS (the port may only refuse more). The port's canonicalPath shortcut (NFC-inert text,
// no tables) is checked for every code point of its table, raw, percent-encoded and between
// letters, against this runtime's own normalize() and toLowerCase(), so it holds on the shipped
// ICU too. The WebAssembly half needs server/wasm/dav-parse.wasm (or DAV_PARSE_WASM); skipped
// without it unless DAV_PARSE_WASM_REQUIRED=1.

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const davParseWasm = require('../../server/dav-parse-wasm.cjs');
const pe = require('../../server/provider-egress.cjs');

const FILE = path.join(__dirname, '../fixtures/provider-egress.v1.json');
const GENERATOR = path.join(__dirname, '../../tools/gen-provider-egress-fixtures.cjs');
const fixtures = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const wasmFile = process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM;
const skipWasm = !fs.existsSync(wasmFile) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built';
const WASM = { impl: 'wasm' };

// project_file_names::NFC_INERT_RANGES (the table provider-egress reuses).
const INERT = [[0x0000, 0x02ff], [0x0400, 0x0482], [0x048a, 0x04ff], [0x2010, 0x2027], [0x2030, 0x205e], [0x3001, 0x3029],
  [0x3041, 0x3096], [0x30a1, 0x30fc], [0x4e00, 0x9fff], [0xac00, 0xd7a3], [0xff01, 0xff60], [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff],
  [0x1f900, 0x1f9ff], [0x1fa70, 0x1faff]];

function quietly(fn) {
  const warn = console.warn;
  console.warn = () => {};
  try { return fn(); } finally { console.warn = warn; }
}

const CALLS = {
  1: ([p]) => davParseWasm.providerEgressExternal(p),
  2: (a) => davParseWasm.providerEgressRefusal(...a),
  3: ([p, sel]) => davParseWasm.providerEgressStrip(p, sel),
  4: (a) => davParseWasm.providerEgressToolRefusal(...a),
  5: ([paths]) => davParseWasm.providerEgressCanonical(paths),
  6: ([s]) => davParseWasm.providerEgressFolder(s),
};

test('the fixture file is what the generator prints', { skip: !fs.existsSync(GENERATOR) && 'no generator here' }, () => {
  const out = execFileSync(process.execPath, [GENERATOR], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(out, fs.readFileSync(FILE, 'utf8'));
});

test('fixture rows: the exact reply; the switched rules equal the JS, or (strict rows) refuse more', { skip: skipWasm }, () => {
  assert.ok(fixtures.rows.length >= 4000);
  let strict = 0;
  for (const [i, row] of fixtures.rows.entries()) {
    const args = JSON.parse(row.wire);
    assert.deepEqual(CALLS[row.op](args), JSON.parse(row.want), `row ${i}`);
    if (row.strict) strict++;
    if (row.op === 1) {
      const [p] = args;
      const js = pe.isExternalProviderJs(p);
      const sw = quietly(() => pe.isExternalProvider(p, WASM));
      assert.ok(row.strict ? sw >= js : sw === js, `row ${i} external`);
      assert.ok(sw === (JSON.parse(row.want).external ?? true) || js, `row ${i} external port`);
    } else if (row.op === 2) {
      const [provider, spaceId, projectId, diaryProjectId] = args;
      const js = pe.egressRefusalJs({ provider, spaceId, projectId, diaryProjectId });
      const sw = quietly(() => pe.egressRefusal({ provider, spaceId, projectId, diaryProjectId }, WASM));
      if (row.strict) assert.ok(js === null || sw === js, `row ${i}`);
      else assert.equal(sw, js, `row ${i}`);
      assert.equal(sw, js ?? JSON.parse(row.want).refusal, `row ${i} switched`);
    } else if (row.op === 3) {
      const [p, sel] = args;
      const a = sel.slice();
      const b = sel.slice();
      const js = pe.stripPrivateToolboxesJs(a, p);
      const sw = quietly(() => pe.stripPrivateToolboxes(b, p, WASM));
      assert.ok(js.length <= sw.length && b.length <= a.length, `row ${i}`);
      if (!row.strict) assert.deepEqual([sw, b], [js, a], `row ${i}`);
    } else if (row.op === 4) {
      const [provider, toolName, rawArgs, storage] = args;
      const js = pe.toolRefusalJs({ provider, toolName, rawArgs, storage });
      const sw = quietly(() => pe.toolRefusal({ provider, toolName, rawArgs, storage }, WASM));
      if (js !== null) assert.equal(sw, js, `row ${i}`);
      else assert.equal(sw, JSON.parse(row.want).refusal, `row ${i} switched`);
    }
  }
  assert.ok(strict > 100, `${strict} strict rows`);
});

test('every NFC-inert code point canonicalizes as this runtime does: raw, percent-encoded and between letters', { skip: skipWasm }, () => {
  let checked = 0;
  for (const [a, b] of INERT) {
    const batch = [];
    for (let cp = a; cp <= b; cp++) {
      const c = String.fromCodePoint(cp);
      batch.push(c, encodeURIComponent(c), `A${c}b`, `${c}${c}`);
    }
    for (let k = 0; k < batch.length; k += 8192) {
      const part = batch.slice(k, k + 8192);
      const { canonical } = davParseWasm.providerEgressCanonical(part);
      for (const [j, p] of part.entries()) {
        assert.equal(canonical[j], pe.canonicalPath(p), `${JSON.stringify(p)} (U+${p.codePointAt(0).toString(16)})`);
      }
    }
    checked += b - a + 1;
  }
  assert.ok(checked > 34_000, `${checked}`);
  // Outside the table the port does not guess.
  assert.deepEqual(davParseWasm.providerEgressCanonical(['Σ', 'é', '%CC%81', 'x\ud800']).canonical, [null, null, null, null]);
});

function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const SEG = ['Diary', 'diary', 'Work', '..', '.', '', '%2F', '%2e%2e', '%252F', 'Tagebücher', 'Tagebücher', 'Tagebu%CC%88cher', 'Ημερα',
  'Σ', 'İ', 'remote.php', 'dav', 'files', 'webdav', 'https:', 'nc.example', '日記', '📓', 'x\ud800', ' ', 'Å'];
const ROOTS = ['Diary', 'Tagebücher', 'Ημερα', 'Work/Diary', '日記', '', 'diary'];
const KEYS = ['path', 'dir', 'q', 'source', 'to', 'depth', 'recursive', 'items', 'name', 'file_id', 'deep'];

test('seeded live calls: the switched rules never let out more than the JS', { skip: skipWasm }, () => {
  const rand = mulberry32(0x1e55);
  const pick = (l) => l[Math.floor(rand() * l.length)];
  const segPath = () => Array.from({ length: Math.floor(rand() * 5) }, () => pick(SEG)).join(pick(['/', '\\', '//']));
  const value = (d) => {
    const r = rand();
    if (d < 3 && r < 0.15) return Object.fromEntries(Array.from({ length: 1 + Math.floor(rand() * 2) }, () => [pick(KEYS), value(d + 1)]));
    if (d < 3 && r < 0.25) return Array.from({ length: Math.floor(rand() * 3) }, () => value(d + 1));
    if (r < 0.3) return pick([true, false, 0, 1, '0', '1', null]);
    return (rand() < 0.1 ? 'https://nc.example/remote.php/dav/files/alice/' : '') + segPath();
  };
  const providers = [null, { kind: 'chatgpt-oauth', label: 'ChatGPT' }, { external: true }, { baseUrl: 'https://integrate.api.nvidia.com/v1' },
    { baseUrl: 'https://ｎｖｉｄｉａ.com/v1' }, { baseUrl: 'http://llama:8080/v1' }, { baseUrl: 'https://xn--nvidia.com/' }];
  let refusedMore = 0, agreed = 0;
  for (let n = 0; n < 4000; n++) {
    const provider = pick(providers);
    const storage = rand() < 0.1 ? null : { kind: pick(['nextcloud', 'webdav', 'nextcloud', 's3']), corpusRoot: pick(ROOTS),
      baseUrl: pick(['https://nc.example/remote.php/dav/files/alice', 'https://nc.example/remote.php/webdav/Shared', 'https://nc.example/', 'nope']) };
    const toolName = pick(['nc_webdav_read_file', 'nc_webdav_search_files', 'nc_webdav_list_directory', 'nc_webdav_move_resource', 'diary_read', 'web_fetch']);
    const args = Object.fromEntries(Array.from({ length: Math.floor(rand() * 4) }, () => [pick(KEYS), value(0)]));
    const rawArgs = rand() < 0.8 ? JSON.stringify(args) : args;
    const js = pe.toolRefusalJs({ provider, toolName, rawArgs, storage });
    const sw = quietly(() => pe.toolRefusal({ provider, toolName, rawArgs, storage }, WASM));
    if (js !== null) assert.equal(sw, js, JSON.stringify([provider, toolName, rawArgs, storage]));
    else if (sw !== null) refusedMore++;
    else agreed++;
    // External, Diary space/project, and toolboxes on the same provider.
    assert.ok(quietly(() => pe.isExternalProvider(provider, WASM)) >= pe.isExternalProviderJs(provider));
    const spaceId = pick(['diary', 'work', null]);
    const ej = pe.egressRefusalJs({ provider, spaceId, projectId: 'p', diaryProjectId: pick(['p', 'q']) });
    if (ej) assert.equal(quietly(() => pe.egressRefusal({ provider, spaceId, projectId: 'p', diaryProjectId: 'p' }, WASM)) !== null, true);
    const sel = ['files', 'diary', 'web'];
    const left = sel.slice();
    quietly(() => pe.stripPrivateToolboxes(left, provider, WASM));
    const leftJs = sel.slice();
    pe.stripPrivateToolboxesJs(leftJs, provider);
    assert.ok(left.every((x) => leftJs.includes(x)));
  }
  assert.ok(refusedMore > 100 && agreed > 500, `${refusedMore} refused more, ${agreed} agreed`);
});

test('the inputs that make the JS regexes quadratic (#1209) stay linear in the port', { skip: skipWasm }, () => {
  const t = process.hrtime.bigint();
  const s = '/remote.php/webdav/x'.repeat(100_000) + '\n';
  const { canonical } = davParseWasm.providerEgressCanonical([s]);
  assert.equal(typeof canonical[0], 'string');
  const r = davParseWasm.providerEgressExternal({ kind: null, external: false, baseUrl: `http://a${'.'.repeat(1_000_000)}b/`, label: '' });
  assert.equal(r.external, false);
  assert.ok(Number(process.hrtime.bigint() - t) / 1e9 < 5);
});
