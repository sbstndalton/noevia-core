'use strict';

// Seeded half of the llama.cpp autoconfig differential (split from llamacpp-autoconfig-differential.test.cjs
// so each file has its own test-timeout budget; the cases and assertions are unchanged). Arguments are built
// in memory the way llamacpp-manager.cjs builds them (undefined members, numbers and odd strings in preset
// options): the switch returns the JS answer and never settings or an estimate the JS would not give.
// Needs server/wasm/dav-parse.wasm (or DAV_PARSE_WASM); skipped without it unless DAV_PARSE_WASM_REQUIRED=1.

const assert = require('node:assert/strict');
const fs = require('node:fs');
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
        assert.equal(JSON.stringify(got), JSON.stringify(js));
        agreed++;
        if (op === 1 && js.values) values++;
      }
    }
  });
  assert.ok(faithful >= 2000, `faithful: ${faithful}`);
  assert.ok(agreed >= 2500, `agreed: ${agreed}`);
  assert.ok(values >= 100, `suggestions with settings: ${values}`);
});
