'use strict';

// Shared body of the seeded llama.cpp autoconfig differential. The 1000 cases of the single seeded
// sequence (seed 0xac0f) are evaluated in four slices, one test file each
// (llamacpp-autoconfig-differential-seeded-{a,b,c,d}.test.cjs), so every file keeps its own
// test-timeout budget on a slow runner. The generator below is the same sequence for every slice: a
// slice replays the stream from case 0 and only evaluates its own half-open index range, so the
// union of the slices is exactly the original 1000 cases with the original assertions.
//
// Arguments are built in memory the way llamacpp-manager.cjs builds them (undefined members, numbers and odd
// strings in preset options): the switch returns the JS answer and never settings or an estimate the JS would
// not give. Needs server/wasm/dav-parse.wasm (or DAV_PARSE_WASM); skipped without it unless
// DAV_PARSE_WASM_REQUIRED=1.
//
// Totals. The thresholds (faithful >= 2000, agreed >= 2500, suggestions with settings >= 100) are about the
// whole sequence, which no single file runs. Each slice therefore asserts its counts EXACTLY against SLICES
// (the counts are deterministic for the seed), and every file also checks, without evaluating anything, that
// SLICES tile 0..1000 and that their sums meet the thresholds. A slice that regressed to fewer agreements
// fails its own exact match, so the union cannot silently fall below a threshold.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const davParseWasm = require('../../server/dav-parse-wasm.cjs');
const ac = require('../../server/llamacpp-autoconfig.cjs');
const oracle = require('../reference/llamacpp-autoconfig-js.cjs');

const wasmFile = process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM;
const skipWasm = !fs.existsSync(wasmFile) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built';
const WASM = { wasmLoader: () => davParseWasm };
const SWITCHED = { 1: ac.suggest, 2: ac.estimateInputs, 3: ac.estimateFootprint };
const JS = { 1: oracle.suggestJs, 2: oracle.estimateInputsJs, 3: oracle.estimateFootprintJs };
const GIB = 1024 ** 3;

const SEED = 0xac0f;
const TOTAL_CASES = 1000;
const THRESHOLDS = { faithful: 2000, agreed: 2500, values: 100 };
const SLICE_FILES = ['a', 'b', 'c', 'd'].map((k) => `llamacpp-autoconfig-differential-seeded-${k}.test.cjs`);
// [from, to) case indexes of the seeded sequence and the exact counts that slice produces.
const SLICES = [
  [0, 250, { faithful: 699, agreed: 746, values: 62 }],
  [250, 500, { faithful: 666, agreed: 745, values: 79 }],
  [500, 750, { faithful: 678, agreed: 749, values: 73 }],
  [750, 1000, { faithful: 684, agreed: 745, values: 70 }],
]; // sums 2727 / 2985 / 284, identical to the former single-file run

function quiet(fn) {
  const warn = console.warn; console.warn = () => {};
  try { return fn(); } finally { console.warn = warn; }
}

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
      arch: pick(['llama', 'arch-a', 'arch-b', 'arch-c', 'synthetic-bert', 'arch-d', 'ünï']), name: 'synthetic',
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
      options, model: pick(['', 'chat-model', 'synthetic-embed', 'synthetic-reranker', undefined]),
    };
  }
}


function runSlice(from, to) {
  let agreed = 0, values = 0, faithful = 0, index = 0;
  quiet(() => {
    for (const a of liveArgs(to, SEED)) {
      if (index++ < from) continue;
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
          assert.equal(port.text, JSON.stringify(js), `case ${index - 1} op ${op}: ${JSON.stringify(args).slice(0, 300)}`);
        }
        let got;
        try { got = SWITCHED[op](args, WASM); } catch (err) { assert.equal(err.code, 'autoconfig_impl'); continue; }
        if (op === 1 && got.code === 'autoconfig_impl') { assert.equal(got.values, undefined); continue; }
        assert.equal(JSON.stringify(got), JSON.stringify(js));
        agreed++;
        if (op === 1 && js.values) values++;
      }
    }
  });
  assert.equal(index, to, 'the sequence has the sliced cases');
  return { faithful, agreed, values };
}

function defineSlice(n) {
  const [from, to, expected] = SLICES[n];
  test(`seeded live arguments, cases ${from}..${to - 1}: the port agrees with this runtime's JS on every JSON-faithful one, and the switch never gives more than the JS`, { skip: skipWasm }, () => {
    assert.deepEqual(runSlice(from, to), expected);
  });
  test('the seeded slices tile the whole sequence and their pinned counts meet the totals thresholds', () => {
    let next = 0; const sum = { faithful: 0, agreed: 0, values: 0 };
    for (const [f, t, c] of SLICES) {
      assert.equal(f, next); next = t;
      for (const k of Object.keys(sum)) sum[k] += c[k];
    }
    assert.equal(next, TOTAL_CASES);
    assert.ok(sum.faithful >= THRESHOLDS.faithful, `faithful: ${sum.faithful}`);
    assert.ok(sum.agreed >= THRESHOLDS.agreed, `agreed: ${sum.agreed}`);
    assert.ok(sum.values >= THRESHOLDS.values, `suggestions with settings: ${sum.values}`);
    assert.deepEqual(fs.readdirSync(__dirname).filter((f) => /^llamacpp-autoconfig-differential-seeded-.*\.test\.cjs$/.test(f)).sort(), SLICE_FILES);
    assert.equal(SLICES.length, SLICE_FILES.length);
  });
}

module.exports = { defineSlice, runSlice, SLICES, SEED, TOTAL_CASES, THRESHOLDS };
