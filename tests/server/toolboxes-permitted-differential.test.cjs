'use strict';

// TOOLBOXES_PERMITTED_IMPL: tests/fixtures/toolboxes-permitted.v1.json (byte-identical to
// noevia-rs crates/toolboxes-permitted/tests/fixtures/; CI compares them) holds
// toolboxes-permitted.cjs's answers, printed by tools/gen-toolboxes-permitted-fixtures.cjs from the
// JS itself (synthetic rows only). Here every row runs through dav-parse.wasm's toolboxes_permitted,
// and a seeded property checks that the switched functions never carry, offer or permit more than
// the JS (and, the port agreeing, return exactly the JS answer). Only ids are compared, never
// folded, so nothing depends on ICU. The WebAssembly half needs server/wasm/dav-parse.wasm (or
// DAV_PARSE_WASM); skipped without it unless DAV_PARSE_WASM_REQUIRED=1.

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const davParseWasm = require('../../server/dav-parse-wasm.cjs');
const tp = require('../../server/toolboxes-permitted.cjs');

const FILE = path.join(__dirname, '../fixtures/toolboxes-permitted.v1.json');
const GENERATOR = path.join(__dirname, '../../tools/gen-toolboxes-permitted-fixtures.cjs');
const fixtures = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const wasmFile = process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM;
const skipWasm = !fs.existsSync(wasmFile) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built';
const WASM = { env: { TOOLBOXES_PERMITTED_IMPL: 'wasm' } };
const RANK = { allowed: 0, 'needs-approval': 1, unavailable: 2 };

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
  1: (a) => davParseWasm.toolboxesProjectIds(...a),
  2: (a) => davParseWasm.toolboxesSelectedIds(...a),
  3: ([i]) => davParseWasm.toolboxesPermitted(i),
};

test('the fixture file is what the generator prints', { skip: !fs.existsSync(GENERATOR) && 'no generator here' }, () => {
  const out = execFileSync(process.execPath, [GENERATOR], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  assert.equal(out, fs.readFileSync(FILE, 'utf8'));
});

test('fixture rows: the exact reply', { skip: skipWasm }, () => {
  assert.ok(fixtures.rows.length >= 1500);
  for (const [i, row] of fixtures.rows.entries()) {
    assert.deepEqual(CALLS[row.op](JSON.parse(row.wire)), JSON.parse(row.want), `row ${i}`);
    assert.equal(row.strict, undefined, 'the port is never stricter here');
  }
});

test('property: the switched functions never carry, offer or permit more than the JS', { skip: skipWasm }, () => {
  const rand = mulberry32(0x7b0c);
  const pick = (l) => l[Math.floor(rand() * l.length)];
  const IDS = ['core', 'web', 'diary', 'gmail', 'notion', 'sso', 'project-docs', 'other'];
  const some = () => IDS.filter(() => rand() < 0.35);
  const project = () => pick([null, { toolboxes: some() }, { toolsMode: 'auto', docsToolboxDefaulted: rand() < 0.5, toolboxes: some() }, { toolsMode: 'manual' },
    { toolboxes: [...some(), 3, null] }, 'odd']);
  const tool = (n) => ({ type: 'function', function: { name: n, description: 'synthetic' } });
  for (let n = 0; n < 600; n++) {
    const p = project(), defaults = some(), connectorBoxes = new Set(pick([[], ['gmail', 'notion']])), connected = pick([[], ['gmail'], ['notion', 'gmail']]);
    const js1 = tp.projectToolboxIdsJs(p, defaults);
    const sw1 = quietly(() => tp.projectToolboxIds(p, defaults, WASM)).value;
    assert.ok(sw1.every((id) => js1.includes(id)));
    if (js1.every((id) => typeof id === 'string')) assert.deepEqual(sw1, js1, 'agreement returns the JS list');
    const sel = { project: p, defaultToolboxes: defaults, connectorBoxes, connected };
    const js2 = tp.selectedToolboxIdsJs(sel);
    assert.deepEqual(quietly(() => tp.selectedToolboxIds(sel, WASM)).value.filter((id) => !js2.includes(id)), []);
    const policy = new Map();
    const input = {
      user: { id: 'u-synthetic', role: pick(['admin', 'member']) }, project: p, mode: pick(['chat', 'cowork']),
      boxes: IDS.filter(() => rand() < 0.5).map((id) => ({ id, label: id, tools: ['read', 'write_x', 'list', 'send'].filter(() => rand() < 0.5).map(tool) })),
      manifest: pick([[], [{ id: 'down' }, { id: 'diary' }, null]]), defaultToolboxes: defaults, connectorBoxes, connected,
      oauthServerIds: new Set(pick([[], ['sso']])), accountReady: () => rand() < 0.5,
      policyMode: (_u, t) => { if (!policy.has(t)) policy.set(t, pick(['allow', 'ask', 'block'])); return policy.get(t); },
      isWriteTool: (name) => name.startsWith('write') || name === 'send', diaryEnabled: rand() < 0.5, harnessEnabled: rand() < 0.5, repositories: pick([[], ['r']]),
    };
    // The same readiness for both runs.
    const ready = rand() < 0.5;
    input.accountReady = () => ready;
    const js = tp.computePermittedToolsJs(input);
    const sw = quietly(() => tp.computePermittedTools(input, WASM)).value;
    assert.deepEqual(sw, js, 'the port agrees with the JS on every synthetic catalogue');
    for (const [k, b] of sw.entries()) {
      assert.ok(b.state === 'unavailable' || js[k].state === 'available');
      for (const [t, x] of b.tools.entries()) assert.ok(RANK[x.permission] >= RANK[js[k].tools[t].permission]);
    }
  }
});
