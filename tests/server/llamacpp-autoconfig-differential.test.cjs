'use strict';

// llama.cpp autoconfig authority retirement: Rust now owns suggestion and estimate decisions. tests/fixtures/llamacpp-autoconfig.v1.json (byte-identical to noevia-rs
// crates/llamacpp-autoconfig/tests/fixtures/; CI compares them) holds llamacpp-autoconfig.cjs's
// answers (suggest, estimateInputs, estimateFootprint and the helpers) as the exact replies the Rust
// port must give, printed by tools/gen-llamacpp-autoconfig-fixtures.cjs from the JS itself
// (synthetic model metadata; nothing is read from disk and no model is loaded). Here every row runs
// through dav-parse.wasm's llamacpp_autoconfig and through the Rust policy operations; the seeded in-memory arguments live in
// llamacpp-autoconfig-differential-seeded.test.cjs (split out so each file keeps its own 120 s budget; same
// cases, same assertions). The WebAssembly half needs server/wasm/dav-parse.wasm (or
// DAV_PARSE_WASM); skipped without it unless DAV_PARSE_WASM_REQUIRED=1.

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const test = require('node:test');

const davParseWasm = require('../../server/dav-parse-wasm.cjs');
const ac = require('../../server/llamacpp-autoconfig.cjs');
const oracle = require('../reference/llamacpp-autoconfig-js.cjs');

const FILE = path.join(__dirname, '../fixtures/llamacpp-autoconfig.v1.json');
const GENERATOR = path.join(__dirname, '../../tools/gen-llamacpp-autoconfig-fixtures.cjs');
const fixtures = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const policyFixtures = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/llamacpp-autoconfig-policy.v1.json'), 'utf8'));
const ORACLE_SHA256 = '66b436f5e2fda9719470fbc18bd92d7b1b52eb6e881885167cdbbebd02eaa040';
const wasmFile = process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM;
const skipWasm = !fs.existsSync(wasmFile) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built';
const WASM = { wasmLoader: () => davParseWasm };
const SWITCHED = { 1: ac.suggest, 2: ac.estimateInputs, 3: ac.estimateFootprint };
const JS = { 1: oracle.suggestJs, 2: oracle.estimateInputsJs, 3: oracle.estimateFootprintJs };
const GIB = 1024 ** 3;

test('the frozen JavaScript oracle remains byte-bound and generates the original fixture answers', () => {
  const oraclePath = path.join(__dirname, '../reference/llamacpp-autoconfig-js.cjs');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(oraclePath)).digest('hex'), ORACLE_SHA256);
  assert.equal(policyFixtures.sourceOracleSha256, ORACLE_SHA256);
  assert.equal(policyFixtures.strictCount, fixtures.strict.length);
});

test('the fixture file is what the generator prints', { skip: !fs.existsSync(GENERATOR) && 'no generator here' }, () => {
  const out = execFileSync(process.execPath, [GENERATOR], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(out, fs.readFileSync(FILE, 'utf8'));
});

test('normal rows keep their original replies through the Rust-owned host API', { skip: skipWasm }, () => {
  for (const [key, op, min] of [['suggest', 1, 500], ['inputs', 2, 150], ['footprint', 3, 400]]) {
    assert.ok(fixtures[key].length >= min, key);
    for (const [i, row] of fixtures[key].entries()) {
      const args = JSON.parse(row.wire);
      const port = davParseWasm.llamacppAutoconfig(op, args);
      assert.equal(port.text, row.reply, `${key} row ${i}`);
      assert.deepEqual(SWITCHED[op](args, WASM), JS[op](args), `${key} row ${i}: confirmed, unchanged`);
    }
  }
  for (const [i, row] of fixtures.helpers.entries()) {
    assert.equal(davParseWasm.llamacppAutoconfig(row.op, JSON.parse(row.wire)).text, row.reply, `helper row ${i}`);
  }
});

test('autotune footprint API matches the frozen estimate for every footprint fixture', { skip: skipWasm }, () => {
  for (const [i, row] of fixtures.footprint.entries()) {
    const args = JSON.parse(row.wire);
    assert.deepEqual(ac.estimateFootprintForAutotune(args, WASM), oracle.estimateFootprintJs(args), `autotune row ${i}`);
  }
});

test('throws stay input errors; strict policy results match the frozen pre-retirement host outcomes', { skip: skipWasm }, () => {
  for (const [i, row] of fixtures.throws.entries()) {
    const args = JSON.parse(row.wire);
    assert.throws(() => davParseWasm.llamacppAutoconfig(row.op, args), (e) => e.reason === 'input', `throws row ${i}`);
  }
  for (const [i, row] of fixtures.strict.entries()) {
    assert.throws(() => davParseWasm.llamacppAutoconfig(row.op, JSON.parse(row.wire)),
      (e) => e.reason === 'ambiguous', 'strict port row ' + i);
  }
  const SWITCHED_BY_OP = {
    1: (args) => ac.suggest(args, WASM),
    2: (args) => ac.estimateInputs(args, WASM),
    3: (args) => ac.estimateFootprint(args, WASM),
    4: (args) => ac.cacheRamMibOf(args.value),
    5: (args) => ac.isPromptCacheFree(args.model, args.options),
    6: (args) => ac.parseMemoryLimit(args.value),
  };
  for (const row of policyFixtures.rows) {
    const fn = SWITCHED_BY_OP[row.op];
    const args = JSON.parse(row.wire);
    const capture = () => {
      try { return { kind: 'return', value: fn(args) }; }
      catch (err) { return { kind: 'throw', name: err.name, code: err.code, status: err.status, message: err.message }; }
    };
    assert.deepEqual(JSON.parse(JSON.stringify(capture())), row.result, 'strict host outcome row ' + row.index);
  }
});

test('typed non-finite inputs preserve checksum-frozen old host outcomes and module faults fail closed', { skip: skipWasm }, () => {
  const meta = { arch: 'llama', contextLength: 131072, embeddingLength: 4096, blockCount: 32, headCount: 32, headCountKv: 8, hasChatTemplate: true };
  const capture = fn => { try { const value = fn(); return { kind: 'return', json: JSON.stringify(value) }; } catch (error) { return { kind: 'throw', name: error.name, code: error.code, status: error.status, message: error.message }; } };
  const cases = [
    ['suggest-budget-nan', 1, { meta, modelBytes: GIB, budgetGib: NaN, current: { 'ctx-size': NaN } }],
    ['inputs-modelbytes-nan', 2, { meta, modelBytes: NaN, current: { 'ctx-size': Infinity, 'ubatch-size': -Infinity } }],
    ['footprint-context-infinity', 3, { meta, modelBytes: GIB, options: { 'ctx-size': Infinity, 'cache-ram': '1024' } }],
    ['footprint-cache-unbounded-nan-context', 3, { meta, modelBytes: GIB, options: { 'cache-ram': -1, 'ctx-size': NaN } }],
    ['footprint-nan-cache-scale', 3, { meta, modelBytes: GIB, options: { 'cache-type-k': 'constructor' } }],
    ['footprint-context-negative-infinity', 3, { meta, modelBytes: GIB, options: { 'ctx-size': -Infinity, 'cache-ram': '1024' } }],
  ];
  assert.equal(policyFixtures.rawNumberCount, policyFixtures.rawNumberRows.length);
  for (const [name, op, args] of cases) {
    const fixture = policyFixtures.rawNumberRows.find(row => row.name === name);
    assert.ok(fixture, `${name} has a frozen old-host answer`);
    assert.equal(fixture.op, op);
    const oldHost = capture(() => ({ 1: oracle.suggest, 2: oracle.estimateInputs, 3: oracle.estimateFootprint })[op](args, WASM));
    const nativeHost = capture(() => SWITCHED[op](args, WASM));
    assert.deepEqual(oldHost, fixture.result, `${name}: oracle still matches its checked-in result`);
    assert.deepEqual(nativeHost, fixture.result, `${name}: Rust-owned API preserves the old wire result`);
  }
  const big = { meta, modelBytes: GIB, budgetGib: 14, current: { 'batch-size': 10n } };
  const oldSuggestion = capture(() => oracle.suggest(big, WASM));
  const nativeSuggestion = capture(() => ac.suggest(big, WASM));
  assert.deepEqual(nativeSuggestion, oldSuggestion);
});

test('the Rust-owned estimator preserves old unbounded-cache behavior beyond the strict pattern cap', { skip: skipWasm }, () => {
  const meta = { arch: 'llama', contextLength: 8192, embeddingLength: 4096, blockCount: 32, headCount: 32, headCountKv: 8, slidingWindow: 4096, slidingWindowPattern: Array.from({ length: 5000 }, (_, i) => i % 3 !== 0) };
  const args = { meta, modelBytes: GIB, options: { 'ctx-size': 8192, 'cache-ram': -1 } };
  const old = oracle.estimateFootprint(args, WASM);
  const got = ac.estimateFootprint(args, WASM);
  assert.equal(JSON.stringify(got), JSON.stringify(old));
  assert.equal(got.cacheRamUnbounded, true);
  assert.equal(ac.estimateFootprintForAutotune(args, WASM).cacheRamUnbounded, true);
});
