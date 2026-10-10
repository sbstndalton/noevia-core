'use strict';

// PROJECT_EDIT_TARGET_IMPL: tests/fixtures/project-edit-target.v1.json (byte-identical to noevia-rs
// crates/project-edit-target/tests/fixtures/; CI compares them) holds project-edit-target.cjs
// planEdit's answers, printed by tools/gen-project-edit-target-fixtures.cjs from the JS itself
// (synthetic projects only). Here every row runs through dav-parse.wasm's project_edit_target;
// seeded properties check that the port never plans an edit the JS refuses and, agreeing, gives the
// JS's exact plan, also through the whole switched planEdit and resolveEditTarget (the chat
// loop's approval card); names with non-ASCII and lone surrogates cross intact; and a large project
// stays fast while an oversized one is refused. The WebAssembly half needs
// server/wasm/dav-parse.wasm (or DAV_PARSE_WASM); skipped without it unless
// DAV_PARSE_WASM_REQUIRED=1.

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const davParseWasm = require('../../server/dav-parse-wasm.cjs');
const et = require('../../server/project-edit-target.cjs');

const FILE = path.join(__dirname, '../fixtures/project-edit-target.v1.json');
const GENERATOR = path.join(__dirname, '../../tools/gen-project-edit-target-fixtures.cjs');
const fixtures = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const wasmFile = process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM;
const skipWasm = !fs.existsSync(wasmFile) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built';
const WASM = { PROJECT_EDIT_TARGET_IMPL: 'wasm' };

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
const jsPlan = (project, raw, account) => {
  try {
    const p = et.planEditJs(project, raw, { storageAccount: account });
    return { plan: { write: p.writeName, target: p.target, adopt: p.adopt }, full: p };
  } catch (err) { return { error: err.message }; }
};

test('the fixture file is what the generator prints, and it is ASCII', { skip: !fs.existsSync(GENERATOR) && 'no generator here' }, () => {
  const out = execFileSync(process.execPath, [GENERATOR], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  assert.equal(out, fs.readFileSync(FILE, 'utf8'));
  assert.ok(/^[\x20-\x7e\n]*$/.test(out));
});

test('fixture rows: the exact reply', { skip: skipWasm }, () => {
  assert.ok(fixtures.rows.length >= 7000);
  let plans = 0;
  for (const [i, row] of fixtures.rows.entries()) {
    const got = davParseWasm.projectEditTarget(JSON.parse(row.wire));
    assert.deepEqual(got, JSON.parse(row.want), `row ${i}`);
    if (got.plan) plans++;
  }
  assert.ok(plans > 1000, `${plans} plans`);
});

const F = 'noevia projects/Alpha', R = 'noevia projects/Reserved';
const NAMES = ['notes.md', 'a.txt', 'b.json', 'r.pdf', 'p.png', 'n', '.md', 'x.MD', 'café.md', 'café.md', '日本.txt', 'k\ud800.md', '\udc00.txt', 'e\u{1f600}.md', 'a.md '];
const FOLDERS = [F, R, 'P', 'noevia projects/Été', null, '', undefined];
function randomProject(rand) {
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const pf = pick(FOLDERS), rf = pick(FOLDERS);
  const files = Array.from({ length: 1 + Math.floor(rand() * 5) }, () => {
    const name = pick(NAMES), r = rand(), folder = pf || pick(FOLDERS) || 'P';
    const attachment = rand() < 0.6 ? { id: 'a', state: pick(['ready', 'ready', 'stored', 'partial']), group: pick(['Text', 'Documents', 'Other']) } : undefined;
    if (r < 0.3) return { name: `${folder}/${pick(['Text', 'Text', 'Documents', 'Images', 'Other', 'Text/sub'])}/${name}`, source: rand() < 0.8 ? folder : 'Attached', attachment };
    if (r < 0.4) return { name, source: 'Attached' };
    if (r < 0.5) return { name: `${rf || pf || 'P'}/Text/${name}` };
    if (r < 0.6) return { name, document: { state: pick(['ready', 'failed']) }, content: pick(['', 'x']) };
    return { name, attachment };
  });
  const f = pick(files);
  const raw = rand() < 0.7 ? f.name : f.name.slice(f.name.lastIndexOf('/') + 1);
  return { project: { projectFolder: pf, reservedFolder: rf, files }, raw, account: pick([null, 'acct-1', '']) };
}

test('seeded: the port never plans what the JS refuses, and agreeing gives the JS plan exactly (module and switched planEdit)', { skip: skipWasm }, () => {
  const rand = mulberry32(0x5eed1e17);
  let asked = 0, plans = 0, adopts = 0;
  for (let i = 0; i < 3000; i++) {
    const { project, raw, account } = randomProject(rand);
    const js = jsPlan(project, raw, account);
    const file = js.full ? js.full.file : require('../../server/project-file-names.cjs').resolveProjectFileJs(project, raw).file;
    const input = file && et.editTargetInput(project, file, account);
    if (input) {
      asked++;
      const port = davParseWasm.projectEditTarget(input);
      if (port.plan) assert.deepEqual(port.plan, js.plan, `case ${i}: the port planned ${JSON.stringify(port.plan)}; the JS ${js.error || 'planned otherwise'}`);
      else assert.ok(js.error, `case ${i}: the port refused (${port.refused}) what the JS plans`);
    }
    // The whole switch: the same answer as the JS, or a refusal.
    const switched = quietly(() => { try { return et.planEdit(project, raw, { env: WASM, storageAccount: account }); } catch (err) { return { error: err.message }; } }).value;
    if (js.error) assert.equal(switched.error, js.error, `case ${i}`);
    else {
      assert.deepEqual(switched, js.full, `case ${i}: the switch refused what both plan`);
      plans++;
      if (js.full.adopt) adopts++;
      const card = et.resolveEditTarget(project, JSON.stringify({ name: raw }), { storageAccount: account, env: WASM });
      assert.deepEqual(card, { path: js.full.target, account: js.full.account }, `case ${i}`);
    }
  }
  assert.ok(asked > 1500 && plans > 300 && adopts > 50, `${asked} asked, ${plans} plans, ${adopts} adopt`);
});

test('every BMP code unit as the name\'s last unit, and as a folder unit, round-trips through the port', { skip: skipWasm }, () => {
  for (let u = 0; u < 0x10000; u += 1) {
    const name = `a${String.fromCharCode(u)}.md`, folder = `P${String.fromCharCode(u)}`;
    const input = [folder, null, true, 0, [name], [null, null, false]];
    const port = davParseWasm.projectEditTarget(input);
    if (name.includes('/')) assert.deepEqual(port, { refused: 'path' });
    else assert.deepEqual(port, { plan: { write: name, target: `${folder}/Text/${name}`, adopt: true } }, `U+${u.toString(16)}`);
  }
});

test('a large project stays fast; an oversized request is refused, never planned', { skip: skipWasm }, () => {
  const files = Array.from({ length: 100000 }, (_, i) => ({ name: `${F}/Text/f${String(i).padStart(6, '0')}.md` }));
  files.push({ name: 'target.md' });
  const project = { projectFolder: F, files };
  const start = process.hrtime.bigint();
  const plan = et.planEdit(project, 'target.md', { env: WASM, storageAccount: 'acct-1' });
  assert.ok(Number(process.hrtime.bigint() - start) / 1e6 < 5000);
  assert.equal(plan.target, `${F}/Text/target.md`);
  const huge = { projectFolder: F, files: [...Array.from({ length: 300000 }, (_, i) => ({ name: `${F}/Text/${'x'.repeat(20)}${i}.md` })), { name: 'target.md' }] };
  assert.ok(et.planEditJs(huge, 'target.md', { storageAccount: 'acct-1' }));
  assert.throws(() => davParseWasm.projectEditTarget(et.editTargetInput(huge, huge.files.at(-1), 'acct-1')), (err) => err.reason === 'too_large');
  const r = quietly(() => assert.throws(() => et.planEdit(huge, 'target.md', { env: WASM, storageAccount: 'acct-1' }), /could not be confirmed/));
  assert.ok(r.seen.every((line) => !line.includes('target.md')));
});
