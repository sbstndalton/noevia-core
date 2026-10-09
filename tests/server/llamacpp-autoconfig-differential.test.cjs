'use strict';

// LLAMACPP_AUTOCONFIG_IMPL: tests/fixtures/llamacpp-autoconfig.v1.json (byte-identical to noevia-rs
// crates/llamacpp-autoconfig/tests/fixtures/; CI compares them) holds llamacpp-autoconfig.cjs's
// answers (suggest, estimateInputs, estimateFootprint and the helpers) as the exact replies the Rust
// port must give, printed by tools/gen-llamacpp-autoconfig-fixtures.cjs from the JS itself
// (synthetic model metadata; nothing is read from disk and no model is loaded). Here every row runs
// through dav-parse.wasm's llamacpp_autoconfig and through the switched functions; then seeded
// arguments built in memory the way llamacpp-manager.cjs builds them (undefined members, numbers
// and odd strings in preset options): the switch returns the JS answer and never settings or an
// estimate the JS would not give. The WebAssembly half needs server/wasm/dav-parse.wasm (or
// DAV_PARSE_WASM); skipped without it unless DAV_PARSE_WASM_REQUIRED=1.

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const davParseWasm = require('../../server/dav-parse-wasm.cjs');
const ac = require('../../server/llamacpp-autoconfig.cjs');

const FILE = path.join(__dirname, '../fixtures/llamacpp-autoconfig.v1.json');
const GENERATOR = path.join(__dirname, '../../tools/gen-llamacpp-autoconfig-fixtures.cjs');
const fixtures = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const wasmFile = process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM;
const skipWasm = !fs.existsSync(wasmFile) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built';
const WASM = { impl: 'wasm' };
const SWITCHED = { 1: ac.suggest, 2: ac.estimateInputs, 3: ac.estimateFootprint };
const JS = { 1: ac.suggestJs, 2: ac.estimateInputsJs, 3: ac.estimateFootprintJs };
const GIB = 1024 ** 3;

function quiet(fn) {
  const warn = console.warn; console.warn = () => {};
  try { return fn(); } finally { console.warn = warn; }
}

test('the fixture file is what the generator prints', { skip: !fs.existsSync(GENERATOR) && 'no generator here' }, () => {
  const out = execFileSync(process.execPath, [GENERATOR], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(out, fs.readFileSync(FILE, 'utf8'));
});

test('answer rows: the exact reply through the port; the switch returns the JS answer', { skip: skipWasm }, () => {
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

test('throws rows are refused as input (the JS throws, so the port is never asked); strict rows as ambiguous, and the switch is never more permissive', { skip: skipWasm }, () => {
  for (const [i, row] of fixtures.throws.entries()) {
    const args = JSON.parse(row.wire);
    assert.throws(() => davParseWasm.llamacppAutoconfig(row.op, args), (e) => e.reason === 'input', `throws row ${i}`);
    if (SWITCHED[row.op]) {
      let asked = false;
      assert.throws(() => SWITCHED[row.op](args, { impl: 'wasm', wasmLoader: () => { asked = true; return davParseWasm; } }), `throws row ${i}: the JS throws`);
      assert.equal(asked, false);
    }
  }
  quiet(() => {
    for (const [i, row] of fixtures.strict.entries()) {
      const args = JSON.parse(row.wire);
      assert.throws(() => davParseWasm.llamacppAutoconfig(row.op, args), (e) => e.reason === 'ambiguous', `strict row ${i}`);
      if (!SWITCHED[row.op]) continue;
      const js = JS[row.op](args);
      let got;
      try { got = SWITCHED[row.op](args, WASM); } catch (err) { assert.equal(err.code, 'autoconfig_impl', `strict row ${i}`); continue; }
      if (row.op === 1 && got.code === 'autoconfig_impl') { assert.equal(got.values, undefined); continue; }
      assert.deepEqual(got, js, `strict row ${i}: only the conservative JS answer passes`);
      if (row.op === 1) assert.ok(js.error !== undefined, 'a refused port never lets JS settings through');
      if (row.op === 3) assert.ok(js.cacheRamUnbounded || Number.isNaN(js.totalGib), 'only a JS estimate that refuses the load');
    }
  });
});

// Arguments as llamacpp-manager.cjs builds them: summarize() metadata, file sizes, the preset's
// effective options ({ ...defaults, ...options }, INI strings; numbers when a caller passes them),
// undefined members included.
function* liveArgs(n, seed) {
  let x = seed >>> 0;
  const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
  const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo));
  const STR = ['', ' ', '0', '-1', '-0', '256', '1024', '2048', '8192', '131072', ' 65536 ', '0x4000', '1e4', 'Infinity', 'abc', '4096.5', ' 512　', undefined];
  const KV = ['f16', 'q8_0', 'Q4_0', 'bf16', 'f32', 'iq4_nl', 'q5_1', 'turbo3', '', undefined, 'constructor'];
  for (let i = 0; i < n; i++) {
    const layers = pick([12, 24, 32, 42, 48, 61, 80]);
    const swa = rnd() < 0.3;
    const meta = {
      arch: pick(['llama', 'qwen35', 'gemma4', 'phi3', 'nomic-bert', 'mistral3', 'ünï']), name: 'synthetic',
      contextLength: pick([2048, 4096, 8192, 32768, 40960, 131072, 262144, 1048576, null, 100000, 5000]),
      embeddingLength: pick([768, 2048, 2560, 4096, 5120, 8192, null]), blockCount: rnd() < 0.05 ? null : layers,
      headCount: pick([8, 16, 32, 40, 64, null]),
      headCountKv: rnd() < 0.2 ? Array.from({ length: layers }, (_, j) => (j % 6 === 5 ? pick([1, 2]) : pick([4, 8]))) : pick([1, 2, 4, 8, null, 0]),
      keyLength: pick([null, 64, 128, 256, 512]), valueLength: pick([null, 64, 128, 256, 512]),
      keyLengthSwa: swa ? pick([null, 128, 256]) : null, valueLengthSwa: swa ? pick([null, 128, 256]) : null,
      slidingWindow: swa ? pick([512, 1024, 4096]) : null,
      slidingWindowPattern: swa && rnd() < 0.7 ? Array.from({ length: rnd() < 0.9 ? layers : layers + 1 }, (_, j) => j % pick([4, 5, 6]) !== 0) : null,
      sharedKvLayers: rnd() < 0.2 ? int(0, layers + 3) : null, fullAttentionInterval: rnd() < 0.2 ? pick([2, 3, 4, 1]) : null,
      ssmStateSize: null, expertCount: rnd() < 0.15 ? pick([8, 64, 128, 1]) : null, nextnPredictLayers: rnd() < 0.15 ? pick([1, 2]) : null,
      hasChatTemplate: rnd() < 0.85,
    };
    const options = {};
    for (const k of ['ctx-size', 'c', 'cache-ram', 'ubatch-size', 'batch-size']) if (rnd() < 0.4) options[k] = rnd() < 0.15 ? pick([4096, 0, -1, 2.5, Infinity, NaN, -0]) : pick(STR);
    for (const k of ['cache-type-k', 'cache-type-v']) if (rnd() < 0.5) options[k] = pick(KV);
    if (rnd() < 0.1) options[pick(['embedding', 'embeddings', 'reranking', 'rerank'])] = pick(['true', 'on', '1', 'false', true]);
    if (rnd() < 0.2) options['spec-type'] = pick(['draft-mtp', 'none', 'ngram']);
    yield {
      meta, modelBytes: pick([0.4, 1, 4.3, 5.56, 9, 17, 30]) * GIB + int(0, 1 << 20), mmprojBytes: rnd() < 0.3 ? pick([0.3, 0.86]) * GIB : 0,
      budgetGib: pick([2, 6, 12, 14, 16, 24, 1e6, 0]), cacheRamMaxMib: pick([undefined, 512, 1024, 2048, 128]),
      options, model: pick(['', 'chat-model', 'nomic-embed', 'bge-reranker', undefined]),
    };
  }
}

test('seeded live arguments: the port agrees with this runtime\'s JS on every JSON-faithful one, and the switch never gives more than the JS', { skip: skipWasm }, () => {
  let agreed = 0, values = 0, faithful = 0;
  quiet(() => {
    for (const a of liveArgs(1000, 0xac0f)) {
      // Undefined members drop and -0 is written 0, which the JS treats alike; NaN and Infinity
      // become null, which it does not.
      const wireable = !Object.values(a.options).some((v) => typeof v === 'number' && !Number.isFinite(v));
      const calls = [
        [1, { meta: a.meta, modelBytes: a.modelBytes, mmprojBytes: a.mmprojBytes, budgetGib: a.budgetGib, current: a.options, cacheRamMaxMib: a.cacheRamMaxMib }],
        [2, { meta: a.meta, modelBytes: a.modelBytes, mmprojBytes: a.mmprojBytes, current: a.options }],
        [3, { meta: a.meta, modelBytes: a.modelBytes, mmprojBytes: a.mmprojBytes, options: a.options, model: a.model }],
      ];
      for (const [op, args] of calls) {
        const js = JS[op](args);
        const port = (() => { try { return davParseWasm.llamacppAutoconfig(op, args); } catch (err) { return { refused: err.reason }; } })();
        if (wireable) {
          faithful++;
          assert.equal(port.text, JSON.stringify(js), `op ${op}: ${JSON.stringify(args).slice(0, 300)}`);
        }
        let got;
        try { got = SWITCHED[op](args, WASM); } catch (err) { assert.equal(err.code, 'autoconfig_impl'); continue; }
        if (op === 1 && got.code === 'autoconfig_impl') { assert.equal(got.values, undefined); continue; }
        assert.deepEqual(got, js);
        agreed++;
        if (op === 1 && js.values) values++;
      }
    }
  });
  assert.ok(faithful >= 2000, `faithful: ${faithful}`);
  assert.ok(agreed >= 2500, `agreed: ${agreed}`);
  assert.ok(values >= 100, `suggestions with settings: ${values}`);
});

test('values JSON cannot carry: the switch keeps the JS answer only when it is the conservative one', { skip: skipWasm }, () => {
  const meta = { arch: 'llama', contextLength: 131072, embeddingLength: 4096, blockCount: 32, headCount: 32, headCountKv: 8, hasChatTemplate: true };
  quiet(() => {
    // ctx-size Infinity (a number): the JS sizes an infinite KV cache, the wire says null.
    const inf = { meta, modelBytes: GIB, options: { 'ctx-size': Infinity, 'cache-ram': '1024' } };
    const js = ac.estimateFootprintJs(inf);
    assert.equal(js.totalGib, null);
    assert.throws(() => ac.estimateFootprint(inf, WASM), (e) => e.code === 'autoconfig_impl', 'an Infinity total is never handed out unconfirmed');
    // cache-ram -1 as a number: the JS estimate refuses any load, so it may stand.
    const open = { meta, modelBytes: GIB, options: { 'cache-ram': -1, 'ctx-size': NaN } };
    assert.deepEqual(ac.estimateFootprint(open, WASM), ac.estimateFootprintJs(open));
    // A BigInt cannot be serialised at all: the port gives no answer, the JS settings are withheld.
    const big = { meta, modelBytes: GIB, budgetGib: 14, current: { 'batch-size': 10n } };
    const s = ac.suggest(big, WASM);
    assert.equal(s.code, 'autoconfig_impl'); assert.equal(s.values, undefined);
  });
});
