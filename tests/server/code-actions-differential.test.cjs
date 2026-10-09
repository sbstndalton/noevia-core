'use strict';

// CODE_ACTIONS_IMPL: tests/fixtures/code-actions.v1.json (byte-identical to noevia-rs
// crates/code-actions/tests/fixtures/; CI compares them) holds code-actions.cjs's classify, decide and
// pickOption answers, printed by tools/gen-code-actions-fixtures.cjs from the JS itself (synthetic
// calls only). Here every row runs through dav-parse.wasm's code_actions and through the switched
// functions; then seeded live calls with non-ASCII text and odd URL hosts against the runtime's own
// JS: the port either agrees byte-for-byte or refuses, the switched answer is never more permissive
// than the JS one, and refusals outside the documented strict cases are counted (none expected).
// The WebAssembly half needs server/wasm/dav-parse.wasm (or DAV_PARSE_WASM); skipped without it
// unless DAV_PARSE_WASM_REQUIRED=1.

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const davParseWasm = require('../../server/dav-parse-wasm.cjs');
const ca = require('../../server/code-actions.cjs');

const FILE = path.join(__dirname, '../fixtures/code-actions.v1.json');
const GENERATOR = path.join(__dirname, '../../tools/gen-code-actions-fixtures.cjs');
const fixtures = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const wasmFile = process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM;
const skipWasm = !fs.existsSync(wasmFile) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built';

const WASM = { impl: 'wasm' };
const RANK = { allow: 0, ask: 1, deny: 2 };
function quietly(fn) {
  const warn = console.warn;
  console.warn = () => {};
  try { return fn(); } finally { console.warn = warn; }
}
const refusal = (fn) => {
  try { fn(); return null; } catch (err) { if (err instanceof davParseWasm.DavParseError) return err.reason; throw err; }
};
/** A call classify() reads exactly as the projection says (classifyInput is not idempotent on locations). */
const callOf = (p) => ({ kind: p.kind, rawInput: p.rawInput, locations: p.locations.map((l) => (l === null ? null : { path: l })) });

test('the fixture file is what the generator prints', { skip: !fs.existsSync(GENERATOR) && 'no generator here' }, () => {
  const out = execFileSync(process.execPath, [GENERATOR], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(out, fs.readFileSync(FILE, 'utf8'));
});

test('classify rows: the same reply text through the Rust port; the switched classify agrees or is stricter', { skip: skipWasm }, () => {
  assert.ok(fixtures.classify.length >= 1000);
  for (const [i, row] of fixtures.classify.entries()) {
    const [projection] = JSON.parse(row.wire);
    const call = callOf(projection);
    if (row.want !== undefined) {
      assert.equal(davParseWasm.codeActionsClassify(projection).text, row.want, `row ${i}`);
      assert.equal(JSON.stringify(ca.classifyJs(call)), row.want, `row ${i} js`);
      assert.deepEqual(ca.classify(call, WASM), JSON.parse(row.want), `row ${i} switched`);
    } else {
      assert.equal(refusal(() => davParseWasm.codeActionsClassify(projection)), row.refused, `row ${i} refused`);
      if (row.refused === 'ambiguous') {
        const c = quietly(() => ca.classify(call, WASM));
        assert.equal(c.unverified, true, `row ${i} switched`);
        assert.equal(c.approval, 'always');
        assert.equal(c.standable, false);
      }
    }
  }
});

test('decide rows: the same decision and reason; strict rows refuse and the switched decide never allows them', { skip: skipWasm }, () => {
  assert.ok(fixtures.decide.length >= 3000);
  let allows = 0;
  for (const [i, row] of fixtures.decide.entries()) {
    const [classified, capabilities, domains, inWorkspace] = JSON.parse(row.wire);
    const input = { classified, capabilities, domains, inWorkspace };
    if (row.want !== undefined) {
      assert.equal(davParseWasm.codeActionsDecide(classified, capabilities, domains, inWorkspace).text, row.want, `row ${i}`);
      assert.deepEqual(ca.decide(input, WASM), JSON.parse(row.want), `row ${i} switched`);
      if (JSON.parse(row.want).decision === 'allow') allows++;
    } else {
      assert.equal(refusal(() => davParseWasm.codeActionsDecide(classified, capabilities, domains, inWorkspace)), row.refused, `row ${i} refused`);
      const js = ca.decideJs(input), switched = quietly(() => ca.decide(input, WASM));
      assert.ok(RANK[switched.decision] >= Math.max(RANK[js.decision], RANK.ask), `row ${i} switched`);
    }
  }
  assert.ok(allows >= 100, 'allow rows are confirmed');
});

test('pick rows: the same option', { skip: skipWasm }, () => {
  for (const [i, row] of fixtures.pick.entries()) {
    const [options, wanted] = JSON.parse(row.wire);
    assert.equal(davParseWasm.codeActionsPick(options, wanted).text, row.want, `row ${i}`);
    assert.deepEqual(ca.pickOption(options, wanted, WASM), JSON.parse(row.want), `row ${i} switched`);
  }
});

// Seeded live calls: the fixture vocabulary plus non-ASCII text and URL hosts the port refuses.
function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const CERTAIN_URLS = ['https://example.com/x', 'http://evil.test:8080', 'https://u:p@api.example.com', 'http://1.2.3.4/', 'HTTP://EXAMPLE.COM', 'http://'];
const UNSURE_URLS = ['https://b\u00fccher.example', 'http://\u1e9e.io', 'https://xn--n3h.example', 'http://0x7f.1', 'http://[::1]', 'http://a..b',
  'https://\u0441\u0430\u0439\u0442.example', 'http://example.com.', 'http://ex%61mple.com', 'https://\uff45xample.com'];
const WORDS = ['ls', 'cat', 'echo', 'rm', 'git', 'push', 'curl', '-q', 'wget', '-qO-', 'npm', 'install', 'sh', '-c', 'eval', 'find', '-exec',
  '{}', ';', 'xargs', 'sudo', 'env', 'FOO=1', '$X', '>', 'out', '|', '&&', '$(', ')', '`', '"', "'", '\\', '\u00e9\u00e8', '\u65e5\u672c\u8a9e',
  '\u0410\u0411', '\ud83d\ude00', '\ud800', '\u00a0', '\u2028', '\u3000', '\ufeff', '\u0301', 'git-push', '-c', 'alias.x=push', 'http.proxy=x'];

test('seeded live calls: the port agrees or refuses as documented; the switched answers are never more permissive', { skip: skipWasm }, () => {
  const rand = mulberry32(0x5eed);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  let agreed = 0, refusedUnsure = 0, falseRefusals = 0;
  for (let n = 0; n < 2000; n++) {
    const parts = [];
    let unsure = false;
    for (let k = 1 + Math.floor(rand() * 8); k > 0; k--) {
      const r = rand();
      if (r < 0.12) { const u = pick(UNSURE_URLS); unsure = true; parts.push(u); } else if (r < 0.3) parts.push(pick(CERTAIN_URLS)); else parts.push(pick(WORDS));
    }
    const call = { kind: pick(['execute', 'execute', 'fetch', 'other', 'read']), rawInput: { command: parts.join(' ') }, locations: [] };
    const js = ca.classifyJs(call);
    // classify never refuses on text: it agrees.
    assert.equal(davParseWasm.codeActionsClassify(ca.classifyInput(call)).text, JSON.stringify(js), JSON.stringify(call));
    const switched = ca.classify(call, WASM);
    assert.deepEqual(switched, js);
    for (const domains of [['example.com'], ['example.com', 'evil.test', '1.2.3.4'], []]) {
      for (const classified of [js, { ...js, approval: 'capability', simple: true }]) {
        const input = { classified, capabilities: [], domains, inWorkspace: null };
        const want = ca.decideJs(input);
        const why = refusal(() => assert.equal(davParseWasm.codeActionsDecide(...ca.decideInput(input)).text, JSON.stringify(want)));
        if (why === null) agreed++;
        else if (unsure && why === 'ambiguous') refusedUnsure++;
        else falseRefusals++;
        const got = quietly(() => ca.decide(input, WASM));
        assert.ok(RANK[got.decision] >= RANK[want.decision], `${JSON.stringify(input)}: ${got.decision} < ${want.decision}`);
        if (why === null) assert.deepEqual(got, want);
      }
    }
  }
  assert.equal(falseRefusals, 0);
  assert.ok(agreed > 8000 && refusedUnsure > 0, `${agreed} agreed, ${refusedUnsure} refused (unsure hosts)`);
});

test('find -exec chains: the port refuses past its bound instead of the JS blow-up', { skip: skipWasm }, () => {
  const t = Date.now();
  const projection = ca.classifyInput({ kind: 'execute', rawInput: { command: `find ${'-exec find '.repeat(5000)}` } });
  assert.equal(refusal(() => davParseWasm.codeActionsClassify(projection)), 'too_large');
  assert.ok(Date.now() - t < 10_000);
});
