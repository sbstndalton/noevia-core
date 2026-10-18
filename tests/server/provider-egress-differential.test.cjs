'use strict';

// Provider egress (PROVIDER_EGRESS_IMPL, retired in #1071: always Rust).
// tests/fixtures/provider-egress.v1.json (byte-identical to noevia-rs crates/provider-egress/tests/fixtures/;
// CI compares them) holds the port's exact replies for synthetic rows, first printed from the former JS rules
// (a `strict` row is one the port answers more strictly: it does not know the path or the URL).
// tests/fixtures/provider-egress-js.v1.json freezes what those JS rules answered for the same rows and for the
// seeded calls below (reason texts carry {label} and {tool} placeholders, so no provider name is committed).
// Both files are frozen and sha256-pinned: the JS rules and their generator are gone, and neither may be
// regenerated through the Rust path (that would erase the independent reference).
// Here every row runs through dav-parse.wasm's provider_egress and through the functions chat.cjs calls. The
// old composition was the union of both sides: the JS refusals stood and the port could only add. With the JS
// gone the port decides alone, so what must hold, and is counted below, is that no frozen JS refusal is let
// out (the port refuses it too), that the port adds refusals only for what it does not know, and that where
// both refuse with different words the port's words are one of the known few.
// The port's canonicalPath shortcut (NFC-inert text, no tables) is checked for every code point of its table,
// raw, percent-encoded and between letters, against this runtime's own normalize() and toLowerCase(), so it
// holds on the shipped ICU too. The WebAssembly half needs server/wasm/dav-parse.wasm (or DAV_PARSE_WASM);
// skipped without it unless DAV_PARSE_WASM_REQUIRED=1.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const davParseWasm = require('../../server/dav-parse-wasm.cjs');
const pe = require('../../server/provider-egress.cjs');

const FILE = path.join(__dirname, '../fixtures/provider-egress.v1.json');
const FROZEN_FILE = path.join(__dirname, '../fixtures/provider-egress-js.v1.json');
// The frozen references are pinned: changing either is a deliberate act that also changes these.
const PINS = { [FILE]: '84980990dc7d5e234d81631f050f45f55a9eaba080a8dfc392e8af3784b6b051', [FROZEN_FILE]: '746d31112529dbc20a2c70c777b968f40ea735968656d50e250459cfe202a6f4' };
const fixtures = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const FROZEN = JSON.parse(fs.readFileSync(FROZEN_FILE, 'utf8'));
const wasmFile = process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM;
const skipWasm = !fs.existsSync(wasmFile) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built';

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

/** A frozen reason text (-1: none), with {label} and {tool} still in it. */
const frozenText = (idx) => (idx < 0 ? null : FROZEN.texts[idx]);
const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** True when `text` is the frozen template with some provider label and this tool name in it. */
const fits = (template, text, tool) => new RegExp(`^${escapeRe(template).split('\\{label\\}').join('.+').split('\\{tool\\}').join(escapeRe(tool))}$`, 's').test(text);
// The ways a refusal can be worded differently from the JS one: the port does not know the folder or the path,
// so it says so, or it reads the path as inside the Diary where the JS read an ancestor.
const OTHER_WORDS = [[/the Diary folder could not be identified, so storage is closed to external providers/, 'folder-unidentified'],
  [/that path is in the Diary folder/, 'path-in-diary-folder'], [/that folder contains the Diary folder/, 'folder-contains-diary']];

/** How a new answer relates to the frozen JS one: same, stricter (JS let it out), or different words for a refusal. */
function relate(template, now, tool = '') {
  if (template === null) return now === null ? 'same-permit' : 'js-permit port-refuses';
  assert.notEqual(now, null, 'a refusal the JS made is let out');
  if (fits(template, now, tool)) return 'same-refusal';
  const kind = OTHER_WORDS.find(([re]) => re.test(now));
  assert.ok(kind, `a refusal with words nobody expected: ${now}`);
  return `both-refuse-other-words:${kind[1]}`;
}
const tally = (t, key) => { t[key] = (t[key] || 0) + 1; };

test('the fixture files are frozen and pinned, line up, and no JS rule, switch or generator remains', () => {
  for (const [file, pin] of Object.entries(PINS)) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), pin, path.basename(file));
  assert.equal(FROZEN.version, 1);
  assert.equal(FROZEN.rows.length, fixtures.rows.length);
  assert.equal(FROZEN.seeded.length, 4000);
  assert.deepEqual(Object.keys(pe).sort(), ['__setStreamGuardEnabledForTests', 'egressRefusal', 'evaluateToolCall', 'isExternalProvider', 'isTrialTermsHost',
    'providerProjection', 'setToolArgumentSchema', 'storageProjection', 'stripPrivateToolboxes', 'toolRefusal', 'validateToolArguments']);
  assert.ok(!fs.existsSync(path.join(__dirname, '../../tools/gen-provider-egress-fixtures.cjs')));
});

test('fixture rows: the port replies exactly as the file says; the rules chat.cjs calls never let out what the frozen JS kept back', { skip: skipWasm }, () => {
  assert.ok(fixtures.rows.length >= 4000);
  const seen = { external: {}, trial: {}, egress: {}, strip: {}, tool: {} };
  let strict = 0;
  for (const [i, row] of fixtures.rows.entries()) {
    const args = JSON.parse(row.wire);
    const reply = CALLS[row.op](args);
    assert.deepEqual(reply, JSON.parse(row.want), `row ${i}`);
    if (row.strict) strict++;
    const frozen = FROZEN.rows[i];
    if (row.op === 1) {
      const [p] = args;
      const ext = quietly(() => pe.isExternalProvider(p)), trial = quietly(() => pe.isTrialTermsHost(p));
      assert.equal(ext, reply.external !== false, `row ${i} external`);
      assert.equal(trial, reply.trial !== false, `row ${i} trial`);
      assert.ok(ext >= (frozen[0] === 1) && trial >= (frozen[1] === 1), `row ${i}: external or trial-terms let out`);
      if (!row.strict) assert.deepEqual([ext, trial], [frozen[0] === 1, frozen[1] === 1], `row ${i}`);
      tally(seen.external, `js=${frozen[0]} now=${ext ? 1 : 0}${reply.external === null ? ' unknown' : ''}`);
      tally(seen.trial, `js=${frozen[1]} now=${trial ? 1 : 0}${reply.trial === null ? ' unknown' : ''}`);
    } else if (row.op === 2) {
      const [provider, spaceId, projectId, diaryProjectId] = args;
      const now = quietly(() => pe.egressRefusal({ provider, spaceId, projectId, diaryProjectId }));
      const rel = relate(frozenText(frozen), now);
      if (!row.strict) assert.ok(rel.startsWith('same'), `row ${i} ${rel}`);
      tally(seen.egress, rel);
    } else if (row.op === 3) {
      const [p, sel] = args;
      const left = sel.slice();
      const removed = quietly(() => pe.stripPrivateToolboxes(left, p));
      assert.equal(removed.length + left.length, sel.length);
      assert.ok(removed.length >= frozen.length, `row ${i}: a private toolbox the JS removed stays`);
      if (!row.strict) assert.equal(removed.length, frozen.length, `row ${i}`);
      tally(seen.strip, removed.length === frozen.length ? 'same' : 'port-removes-more');
    } else if (row.op === 4) {
      const [provider, toolName, rawArgs, storage] = args;
      const now = quietly(() => pe.toolRefusal({ provider, toolName, rawArgs, storage }));
      const rel = relate(frozenText(frozen), now, String(toolName || ''));
      if (!row.strict) assert.ok(rel.startsWith('same'), `row ${i} ${rel}`);
      if (rel.startsWith('both')) assert.ok(row.strict, `row ${i} only strict rows change words`);
      tally(seen.tool, rel);
    }
  }
  assert.ok(strict > 100, `${strict} strict rows`);
  assert.deepEqual(seen, {"external":{"js=0 now=0":16,"js=1 now=1":11,"js=1 now=1 unknown":3,"js=0 now=1 unknown":1},"trial":{"js=0 now=0":18,"js=1 now=1":8,"js=1 now=1 unknown":3,"js=0 now=1 unknown":2},"egress":{"same-permit":226,"same-refusal":152},"strip":{"same":30},"tool":{"same-refusal":1732,"same-permit":1301,"js-permit port-refuses":301,"both-refuse-other-words:folder-unidentified":99,"both-refuse-other-words:path-in-diary-folder":1}});
});

test('the crate refuses only Diary tools and storage tools: every other tool name is allowed without asking, as chat.cjs relies on', { skip: skipWasm }, () => {
  const provider = pe.providerProjection({ external: true, label: 'Label' });
  const storage = pe.storageProjection({ kind: 'nextcloud', corpusRoot: 'Diary', baseUrl: 'https://nc.example/remote.php/dav/files/alice' });
  const args = JSON.stringify({ path: 'Diary/x.md', fileId: 5, file: 'Diary/y' });
  for (const name of ['web_fetch', 'files_read', 'project_read_file', 'nc_webdav', 'NC_WEBDAV_read_file', 'Diary_read', 'xdiary_read', 'diary', 'ncwebdav_read', 'read_nc_webdav_file', '']) {
    assert.equal(davParseWasm.providerEgressToolRefusal(provider, name, args, storage).refusal, null, JSON.stringify(name));
  }
  for (const name of ['diary_read', 'diary_', 'nc_webdav_read_file', 'nc_webdav_']) {
    assert.notEqual(davParseWasm.providerEgressToolRefusal(provider, name, args, storage).refusal, null, name);
  }
  // A local provider is never refused, whatever the tool (chat.cjs does not send its arguments at all).
  const local = pe.providerProjection({ label: 'Local', baseUrl: 'http://llama:8080/v1' });
  for (const name of ['diary_read', 'nc_webdav_read_file']) assert.equal(davParseWasm.providerEgressToolRefusal(local, name, args, storage).refusal, null, name);
});

test('every NFC-inert code point canonicalizes as this runtime does: raw, percent-encoded and between letters', { skip: skipWasm }, () => {
  // The reference is the rule the port mirrors (the former JS canonicalPath), over this runtime's normalize() and toLowerCase().
  const reference = (value) => {
    let text = String(value ?? '').normalize('NFC');
    for (let i = 0; i < 3 && /%[0-9a-f]{2}/i.test(text); i++) { try { text = decodeURIComponent(text); } catch { break; } }
    text = text.normalize('NFC').replace(/\\/g, '/');
    const dav = /(?:^[a-z][a-z0-9+.-]*:\/\/[^/]*)?\/?remote\.php\/(?:dav\/files\/[^/]+|webdav)(\/.*)?$/i.exec(text);
    if (dav) text = dav[1] || '';
    else text = text.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '');
    const out = [];
    for (const segment of text.split('/')) {
      if (!segment || segment === '.') continue;
      if (segment === '..') { out.pop(); continue; }
      out.push(segment);
    }
    return out.join('/').toLowerCase().normalize('NFC');
  };
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
        assert.equal(canonical[j], reference(p), `${JSON.stringify(p)} (U+${p.codePointAt(0).toString(16)})`);
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
const SEG = ['Diary', 'diary', 'Work', '..', '.', '', '%2F', '%2e%2e', '%252F', 'Tagebücher', 'Tagebücher', 'Tagebu%CC%88cher', 'Ημερα',
  'Σ', 'İ', 'remote.php', 'dav', 'files', 'webdav', 'https:', 'nc.example', '日記', '📓', 'x\ud800', ' ', 'Å'];
const ROOTS = ['Diary', 'Tagebücher', 'Ημερα', 'Work/Diary', '日記', '', 'diary'];
const KEYS = ['path', 'dir', 'q', 'source', 'to', 'depth', 'recursive', 'items', 'name', 'file_id', 'deep'];

test('seeded live calls: no frozen JS refusal is let out; the port adds refusals only where it is stricter, and every kind is counted', { skip: skipWasm }, () => {
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
  const seen = { tool: {}, external: {}, egress: {}, strip: {} };
  for (let n = 0; n < 4000; n++) {
    const provider = pick(providers);
    const storage = rand() < 0.1 ? null : { kind: pick(['nextcloud', 'webdav', 'nextcloud', 's3']), corpusRoot: pick(ROOTS),
      baseUrl: pick(['https://nc.example/remote.php/dav/files/alice', 'https://nc.example/remote.php/webdav/Shared', 'https://nc.example/', 'nope']) };
    const toolName = pick(['nc_webdav_read_file', 'nc_webdav_search_files', 'nc_webdav_list_directory', 'nc_webdav_move_resource', 'diary_read', 'web_fetch']);
    const args = Object.fromEntries(Array.from({ length: Math.floor(rand() * 4) }, () => [pick(KEYS), value(0)]));
    const rawArgs = rand() < 0.8 ? JSON.stringify(args) : args;
    const [toolIdx, extJs, egressIdx, leftJs] = FROZEN.seeded[n];
    const where = `call ${n}`;
    // Tool call.
    const now = quietly(() => pe.toolRefusal({ provider, toolName, rawArgs, storage }));
    tally(seen.tool, relate(frozenText(toolIdx), now, toolName));
    // External provider.
    const ext = quietly(() => pe.isExternalProvider(provider));
    assert.ok(ext >= (extJs === 1), `${where}: external let out`);
    tally(seen.external, `js=${extJs} now=${ext ? 1 : 0}`);
    // The Diary space or project on the same provider, and the toolboxes.
    const spaceId = pick(['diary', 'work', null]);
    const diaryProjectId = pick(['p', 'q']);
    const egress = quietly(() => pe.egressRefusal({ provider, spaceId, projectId: 'p', diaryProjectId }));
    tally(seen.egress, relate(frozenText(egressIdx), egress));
    const left = ['files', 'diary', 'web'];
    quietly(() => pe.stripPrivateToolboxes(left, provider));
    assert.ok(left.length <= leftJs, `${where}: a private toolbox the JS removed stays`);
    assert.ok(left.every((x) => x !== 'diary') || leftJs === 3, where);
    tally(seen.strip, left.length === leftJs ? 'same' : 'port-removes-more');
  }
  assert.deepEqual(seen, {"tool":{"same-permit":1838,"same-refusal":1529,"both-refuse-other-words:folder-unidentified":108,"js-permit port-refuses":520,"both-refuse-other-words:path-in-diary-folder":5},"external":{"js=0 now=0":1164,"js=1 now=1":2267,"js=0 now=1":569},"egress":{"same-permit":2092,"same-refusal":1525,"js-permit port-refuses":383},"strip":{"same":3431,"port-removes-more":569}});
});

test('the #1209 inputs are bounded in the port and through the rules chat.cjs calls', { skip: skipWasm }, () => {
  const t = process.hrtime.bigint();
  const s = '/remote.php/webdav/x'.repeat(100_000) + '\n';
  const { canonical } = davParseWasm.providerEgressCanonical([s]);
  assert.equal(typeof canonical[0], 'string');
  const r = davParseWasm.providerEgressExternal({ kind: null, external: false, baseUrl: `http://a${'.'.repeat(1_000_000)}b/`, label: '' });
  assert.equal(r.external, false);
  const storage = { kind: 'nextcloud', corpusRoot: 'Diary', baseUrl: 'https://nc.example/remote.php/dav/files/alice' };
  const call = { provider: { external: true }, toolName: 'nc_webdav_read_file', rawArgs: JSON.stringify({ path: s }), storage };
  assert.match(quietly(() => pe.toolRefusal(call)), /in the Diary folder/);
  assert.equal(quietly(() => pe.isExternalProvider({ baseUrl: `http://a${'.'.repeat(1_000_000)}b/` })), false);
  assert.ok(Number(process.hrtime.bigint() - t) / 1e9 < 5);
});
