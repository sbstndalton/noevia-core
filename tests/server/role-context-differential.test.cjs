'use strict';

// ROLE_CONTEXT_IMPL: tests/fixtures/role-context.v1.json (byte-identical to noevia-rs
// crates/role-context/tests/fixtures/; CI compares them) holds role-context.cjs's projections,
// dossiers, refusals and leak verdicts as the exact replies the Rust port must give, printed by
// tools/gen-role-context-fixtures.cjs from the JS itself (synthetic states, ASCII only there). Here
// every row runs through dav-parse.wasm's role_context and through the switched projectRoleContext /
// projectSharedDossier; then seeded live states, including non-ASCII text whose treatment follows
// this runtime's ICU: the port agrees with this runtime's JS or refuses, and the switched function
// never hands out anything the JS would not. The WebAssembly half needs server/wasm/dav-parse.wasm
// (or DAV_PARSE_WASM); skipped without it unless DAV_PARSE_WASM_REQUIRED=1.

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const davParseWasm = require('../../server/dav-parse-wasm.cjs');
const rc = require('../../server/role-context.cjs');

const FILE = path.join(__dirname, '../fixtures/role-context.v1.json');
const GENERATOR = path.join(__dirname, '../../tools/gen-role-context-fixtures.cjs');
const fixtures = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const wasmFile = process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM;
const skipWasm = !fs.existsSync(wasmFile) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built';

const JS = { impl: 'js' };
const WASM = { impl: 'wasm' };

/** The port's answer as the wire reply text (what the fixture records). */
function portReply(op, a, state) {
  const key = op === 1 ? 'projection' : 'dossier';
  const r = op === 1 ? davParseWasm.roleContextProject(a, state) : davParseWasm.roleContextDossier(a, state);
  if (r.leak) return JSON.stringify({ leak: r.leak });
  if (r.refused) return JSON.stringify({ refused: r.refused });
  return JSON.stringify({ [key]: r.value, redactions: r.redactions });
}

/** The JS's answer, run directly (`impl`) as the same reply text. */
function jsReply(op, a, state, impl = JS) {
  try {
    if (op === 1) { const r = rc.projectRoleContext(a, state, impl); return JSON.stringify({ projection: r.projection, redactions: r.meta.redactions }); }
    const r = rc.projectSharedDossier(state, { roles: a, ...impl });
    return JSON.stringify({ dossier: r.dossier, redactions: r.meta.redactions });
  } catch (err) {
    if (err instanceof rc.RoleContextLeakError) return JSON.stringify({ leak: err.classes });
    if (err instanceof rc.RoleContextError) return JSON.stringify({ refused: err.code });
    throw err;
  }
}

test('the fixture file is what the generator prints', { skip: !fs.existsSync(GENERATOR) && 'no generator here' }, () => {
  const out = execFileSync(process.execPath, [GENERATOR], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(out, fs.readFileSync(FILE, 'utf8'));
});

test('project and dossier rows: the exact reply through the port; the switch hands out the same', { skip: skipWasm }, () => {
  assert.ok(fixtures.project.length >= 120 && fixtures.dossier.length >= 15);
  for (const [key, op] of [['project', 1], ['dossier', 2]]) {
    for (const row of fixtures[key]) {
      const [a, state] = JSON.parse(row.wire);
      assert.equal(portReply(op, a, state), row.reply, `${key} ${row.name}`);
      assert.equal(jsReply(op, a, state), row.reply, `${key} ${row.name} (js)`);
      assert.equal(jsReply(op, a, state, WASM), row.reply, `${key} ${row.name} (switched)`);
    }
  }
});

test('unicode disguises: the port refuses them as leaks, and so does the switch', { skip: skipWasm }, () => {
  for (const row of fixtures.unicodeRefused) {
    const [a, state] = JSON.parse(row.wire);
    assert.ok(portReply(row.op, a, state).startsWith('{"leak":['), row.name);
    assert.ok(jsReply(row.op, a, state, WASM).startsWith('{"leak":['), `${row.name} (switched)`);
  }
});

test('strict rows: the port refuses as ambiguous; the switch never hands them out', { skip: skipWasm }, () => {
  const warn = console.warn; console.warn = () => {};
  try {
    for (const row of fixtures.strict) {
      assert.equal(row.reply, '{"error":"ambiguous"}');
      const [a, state] = JSON.parse(row.wire);
      assert.throws(() => portReply(row.op, a, state), { reason: 'ambiguous' }, row.name);
      const switched = jsReply(row.op, a, state, WASM);
      assert.ok(switched.startsWith('{"leak":[') || switched.startsWith('{"refused":'), `${row.name}: ${switched}`);
    }
  } finally { console.warn = warn; }
});

test('an unpaired literal escape in a patch (\\uD800) is refused as ambiguous, never handed out', { skip: skipWasm }, () => {
  // Documents the port's strictness (sbstndalton/noevia#1120, measure only): the text is a backslash,
  // "uD800", not a lone surrogate, and the port does not guess what a later JSON.parse would make of it.
  const state = {
    taskId: 't-1', tenantId: 'tenant-alice', request: 'Fix the parser',
    change: { files: [{ path: 'parse.js', patch: '--- a/parse.js\n+++ b/parse.js\n@@ -1 +1 @@\n-const x = "\\u0041";\n+const x = "\\uD800";\n' }] },
  };
  assert.ok(state.change.files[0].patch.includes('\\uD800'));
  const warn = console.warn; console.warn = () => {};
  try {
    // Only the reviewer's projection carries the change; the executor's does not, so it is not ambiguous there.
    for (const [op, a] of [[1, 'reviewer']]) {
      assert.throws(() => portReply(op, a, JSON.parse(JSON.stringify(state))), { reason: 'ambiguous' }, `${op} ${a}`);
      const switched = jsReply(op, a, JSON.parse(JSON.stringify(state)), WASM);
      assert.ok(!switched.startsWith('{"projection"') && !switched.startsWith('{"dossier"'), `switch must not hand it out: ${switched.slice(0, 120)}`);
    }
  } finally { console.warn = warn; }
});

test('seeded live states: the port agrees with this runtime or refuses; the switch never widens', { skip: skipWasm }, () => {
  let seed = 515;
  const rnd = (m) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 16) % m; };
  const pick = (xs) => xs[rnd(xs.length)];
  const CANARY = ['DIARY-LIVE-CANARY-0101 entry text', 'OTHER-LIVE-CANARY-0202 tenant text', 'appr-LIVE-0303-token', 'cred-LIVE-0404-value', 'tenant-zed-0505'];
  const PIECES = ['plain words', 'Notes.md', 'Planner', 'approve_all', 'café', 'Ｆｕｌｌ', 'zero​width', 'soft­hyphen', 'ΣΊΣΥΦΟΣ', 'emoji 😀 ok', 'ß', 'İstanbul',
    '\t"quoted"\\', '\\u0041\\u00e9', 'a'.repeat(70)];
  const RISKY = ['sk-live0000aaaa1111bbbb', 'ghp_abcdefghijklmnopqrstuvwxyz', 'bearer 0123456789abcdefXYZ', ...CANARY,
    ...CANARY.map((c) => c.toLowerCase()), ...CANARY.map((c) => c.slice(3))];
  const text = () => Array.from({ length: 1 + rnd(4) }, () => (rnd(10) ? pick(PIECES) : pick(RISKY))).join(pick([' ', '', '\n']));
  const list = (n) => Array.from({ length: rnd(n) }, text);
  const ROLES = ['planner', 'executor', 'auditor', 'reviewer'];
  let agreed = 0, refused = 0, handed = 0, lost = 0;
  const warn = console.warn; console.warn = () => {};
  try {
    for (let n = 0; n < 600; n++) {
      const state = {
        taskId: pick(['t-1', 7, 'Täsk']), tenantId: 'tenant-alice', request: text(), projectInstructions: rnd(2) ? text() : undefined,
        constraints: list(4), feedback: list(3), capabilities: list(5).map((name) => (rnd(2) ? { name, description: text() } : name)),
        plan: { goal: text(), steps: list(3).map((d) => ({ do: d, done_when: text() })), constraints: list(3), non_goals: list(2) },
        execution: { summary: text(), changedFiles: list(3), testResults: [{ name: text(), passed: true }] },
        change: { files: list(3).map((p) => ({ path: p, patch: text() })) },
        snippets: list(4).map((t, i) => ({ source: pick(['project', 'selected', 'diary', 'Diary', 'repo-public', 'private']), tenantId: pick(['tenant-alice', 'tenant-zed-0505', 4242]), text: t, label: i ? text() : undefined })),
        roleSystemPrompts: { planner: 'You plan the work.', executor: 'You execute the plan.', auditor: rnd(2) ? text() : 'You audit.' },
        orchestrator: { metaPrompt: 'META-LIVE-CANARY-0606 route everything quietly between the roles', routing: pick(['save_note', text()]) },
        diary: { e: CANARY[0] }, otherTenants: { 'tenant-zed-0505': CANARY[1] },
        approvals: [{ id: 'appr-1', token: CANARY[2], decision: pick(['approve', 'deny', 'approve_all', 'x']) }],
        credentials: { k: CANARY[3] },
      };
      const live = JSON.parse(JSON.stringify(state));
      const op = rnd(4) ? 1 : 2;
      const a = op === 1 ? pick(ROLES) : pick([['planner', 'executor'], ROLES, ['auditor']]);
      const js = jsReply(op, a, live);
      let port;
      try { port = portReply(op, a, live); } catch (err) { assert.ok(['ambiguous', 'too_large'].includes(err.reason), String(err.reason)); refused++; continue; }
      // The port's leak class list may differ only if the JS refused too (both refuse).
      if (port !== js) assert.ok(!port.startsWith('{"projection"') && !port.startsWith('{"dossier"'), `port handed out what the JS did not: ${a} ${js.slice(0, 120)} / ${port.slice(0, 120)}`);
      else agreed++;
      // Where the JS hands the context out and the port answers (not ambiguous / too_large, which
      // `continue` above) with a leak or a refusal, the switched function refuses what the JS
      // would have sent: a false refusal. The seeded states must have none.
      const handedOut = (r) => r.startsWith('{"projection"') || r.startsWith('{"dossier"');
      if (handedOut(js) && !handedOut(port)) lost++;
      const switched = jsReply(op, a, live, WASM);
      if (switched.startsWith('{"projection"') || switched.startsWith('{"dossier"')) { assert.equal(switched, js); handed++; }
    }
  } finally { console.warn = warn; }
  console.log(`live: ${agreed} agreed, ${refused} refused, ${handed} handed out, ${lost} handed out by the JS but refused by the port`);
  assert.equal(lost, 0, `${lost} runs where the JS handed out and the port refused or flagged a leak`);
  assert.ok(agreed > 500 && handed > 100, `${agreed} agreed, ${refused} refused, ${handed} handed out`);
});
