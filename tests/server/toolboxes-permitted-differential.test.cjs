'use strict';

// Permitted tools (TOOLBOXES_PERMITTED_IMPL, retired in #1071: always Rust).
// tests/fixtures/toolboxes-permitted.v1.json (byte-identical to noevia-rs
// crates/toolboxes-permitted/tests/fixtures/; CI compares them) holds the port's exact replies for synthetic
// rows, first printed from the former JS rules (the port is never stricter than the JS there, so no row is
// `strict`). tests/fixtures/toolboxes-permitted-js.v1.json freezes what the old toolboxes-permitted.cjs
// answered for 2500 seeded synthetic inputs (odd project shapes, boxes with odd tools, manifests, callbacks
// answering with odd values): the project ids, the selected ids and the per-turn catalogue, each as the JS alone
// (`js`) and as the live composition (`live`, TOOLBOXES_PERMITTED_IMPL=wasm: the JS carried only as far as the
// port agreed, which is what ran). Both files are frozen and sha256-pinned: the JS rules and their generator are
// gone, and neither may be regenerated through the Rust path (that would erase the independent reference).
// Provenance (also in the frozen file's `note`): frozen from noevia-core at 1ef1ecf with the dav-parse.wasm that
// server/dav-parse.lock pins present.
// What must hold, and is counted below: for every frozen input the functions give exactly what the live
// composition gave (so nothing is carried, offered or permitted that live refused), which is the JS answer or,
// where the port could not answer (a projection it cannot carry, a fault), no ids and every box and tool
// unavailable ('unchecked'); never more than the JS alone. The one difference: a carried id that is not a
// string (live kept it from the JS list; it matches no box) is no longer in the list. Only ids are compared,
// never folded, so nothing depends on ICU. The WebAssembly half needs server/wasm/dav-parse.wasm (or
// DAV_PARSE_WASM); skipped without it unless DAV_PARSE_WASM_REQUIRED=1.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const davParseWasm = require('../../server/dav-parse-wasm.cjs');
const tp = require('../../server/toolboxes-permitted.cjs');

const FILE = path.join(__dirname, '../fixtures/toolboxes-permitted.v1.json');
const FROZEN_FILE = path.join(__dirname, '../fixtures/toolboxes-permitted-js.v1.json');
// The frozen references are pinned: changing either is a deliberate act that also changes these.
const PINS = { [FILE]: '2f3937d5a5876d79d288969476fb224e79dab4d2fba8cfb4a7272ed2801bd737', [FROZEN_FILE]: '1aff93ac23e096837f167433a569b6193521656aba35f7702fdddcaeed6f685e' };
const fixtures = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const FROZEN = JSON.parse(fs.readFileSync(FROZEN_FILE, 'utf8'));
const wasmFile = process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM;
const skipWasm = !fs.existsSync(wasmFile) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built';
// Guards a wrong test signature (options passed twice makes node:test take the second object as the body, so the
// body never runs and the test reports ok): when the module is there, every guarded body must have run.
let ran = 0;
test.after(() => { if (!skipWasm) assert.equal(ran, 2, 'a wasm-guarded test body did not run'); });

const sha = (v) => crypto.createHash('sha256').update(Buffer.isBuffer(v) ? v : JSON.stringify(v)).digest('hex');
function quietly(fn) {
  const warn = console.warn;
  console.warn = () => {};
  try { return fn(); } finally { console.warn = warn; }
}
// The frozen hashes are of the key-sorted JSON.
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v === undefined ? null : v));
const H = (v) => crypto.createHash('sha256').update(canon(v)).digest('hex').slice(0, 16);

const CALLS = {
  1: (a) => davParseWasm.toolboxesProjectIds(...a),
  2: (a) => davParseWasm.toolboxesSelectedIds(...a),
  3: ([i]) => davParseWasm.toolboxesPermitted(i),
};

// What the freeze script made of a case: the callbacks are data, a description LONG stands for 300 characters.
const expand = (b) => ({ ...b, tools: b.tools && b.tools.map((t) => (t && t.function && t.function.description === 'LONG' ? { ...t, function: { ...t.function, description: 'd'.repeat(300) } } : t)) });
const toInput = (c) => ({
  user: c.user, project: c.project, mode: c.mode, boxes: c.boxes.map(expand), manifest: c.manifest, defaultToolboxes: c.defaultToolboxes,
  connectorBoxes: new Set(c.connectorBoxes), connected: c.connected, oauthServerIds: new Set(c.oauthServerIds),
  accountReady: (_u, id) => c.ready[id], policyMode: (_u, t) => c.policy[t], isWriteTool: (n) => c.write[n],
  diaryEnabled: c.diaryEnabled, harnessEnabled: c.harnessEnabled, repositories: c.repositories,
});

test('the shared fixture and the frozen JS answers are the pinned files', () => {
  for (const [file, pin] of Object.entries(PINS)) assert.equal(sha(fs.readFileSync(file)), pin, path.basename(file));
  assert.equal(FROZEN.cases.length, 2500);
  assert.match(FROZEN.note, /freeze script \(sha256 [0-9a-f]{64}\)/);
  assert.match(FROZEN.note, /dav-parse\.wasm that server\/dav-parse\.lock pins \(sha256 [0-9a-f]{64}\)/);
  assert.ok(fixtures.rows.length >= 1500);
});

test('fixture rows: the exact reply', { skip: skipWasm }, () => {
  ran++;
  for (const [i, row] of fixtures.rows.entries()) {
    assert.deepEqual(CALLS[row.op](JSON.parse(row.wire)), JSON.parse(row.want), `row ${i}`);
    assert.equal(row.strict, undefined, 'the port is never stricter here');
  }
});

test('frozen inputs: the two id functions give what the live composition gave, and never more than the JS alone', { skip: skipWasm }, () => {
  ran++;
  const count = { total: 0, projectSame: 0, selectedSame: 0, selectedFault: 0, selectedNonString: 0 };
  const strings = (l) => l.filter((id) => typeof id === 'string');
  for (const { i, in: c, project, selected, catalogue } of FROZEN.cases) {
    const label = `case ${i}`;
    // Project ids: live is the JS list when the port agrees (here always); non-string entries match no box and are not carried.
    const p = quietly(() => tp.projectToolboxIds(c.project, c.defaultToolboxes));
    assert.deepEqual(p, strings(project.live), label);
    assert.deepEqual(p, strings(project.js), label);
    count.projectSame++;
    // Selected ids: live is the JS list, or none when the port could not carry the request.
    const input = toInput(c);
    const s = quietly(() => tp.selectedToolboxIds({ project: input.project, defaultToolboxes: input.defaultToolboxes, connectorBoxes: input.connectorBoxes, connected: input.connected }));
    assert.deepEqual(s, strings(selected.live), label);
    if (selected.live.length !== selected.js.length) { count.selectedFault++; assert.deepEqual(selected.live, [], label); assert.deepEqual(s, [], label); } else count.selectedSame++;
    for (const id of s) assert.ok(selected.js.includes(id), `${label}: ${id} was carried by the JS alone`);
    if (selected.live.some((id) => typeof id !== 'string')) count.selectedNonString++;
    count.total++;
  }
  assert.deepEqual(count, { total: 2500, projectSame: 2500, selectedSame: 2099, selectedFault: 401, selectedNonString: 523 });
});
