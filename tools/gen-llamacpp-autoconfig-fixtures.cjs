#!/usr/bin/env node
'use strict';
// Regenerates the shared fixtures for LLAMACPP_AUTOCONFIG_IMPL: llamacpp-autoconfig.cjs's suggest,
// estimateInputs and estimateFootprint, and its cacheRamMibOf, isPromptCacheFree and
// parseMemoryLimit. The same file is committed byte-for-byte in sbstndalton/noevia-rs
// (crates/llamacpp-autoconfig/tests/fixtures/llamacpp-autoconfig.v1.json); noevia-core CI compares
// them.
//   node tools/gen-llamacpp-autoconfig-fixtures.cjs > tests/fixtures/llamacpp-autoconfig.v1.json
//
// Every expectation is what the JS itself returns, evaluated on the arguments exactly as they cross
// the wire (JSON.parse of `wire`), written as JSON.stringify writes it (the port's reply). All model
// metadata is synthetic (no model file is read, nothing is loaded). Nothing recorded depends on the
// Node/ICU version (#1115): the only locale formatting is toLocaleString('en-US') of integers up to
// 2^53 - 1 (plain digit grouping); a native context past that, or not an integer, is in the strict
// table, which records no JS answer.
//
// Sections (the wire is the request after the op byte):
//   suggest / inputs / footprint: { wire, reply }   ops 1 / 2 / 3
//   helpers: { op, wire, reply }                    ops 4 cacheRamMibOf, 5 isPromptCacheFree,
//                                                   6 parseMemoryLimit
//   throws:  { op, wire }   the JS throws; the port refuses 'input'
//   strict:  { op, wire }   the JS answers; the port refuses 'ambiguous'

const path = require('node:path');
const ac = require(path.join(__dirname, '..', 'server', 'llamacpp-autoconfig.cjs'));

const GIB = 1024 ** 3;
const OPS = { 1: (a) => ac.suggestJs(a), 2: (a) => ac.estimateInputsJs(a), 3: (a) => ac.estimateFootprintJs(a),
  4: (a) => { const n = ac.cacheRamMibOf(a.value); return n === Infinity ? { unbounded: true } : { mib: n }; },
  5: (a) => ({ free: ac.isPromptCacheFree(a.model, a.options) }),
  6: (a) => { const g = ac.parseMemoryLimit(a.value); return { gib: g === Infinity ? 'Infinity' : g }; } };

function answer(op, args) {
  const wire = JSON.stringify(args);
  const reply = JSON.stringify(OPS[op](JSON.parse(wire)));
  if (typeof reply !== 'string') throw Error('no reply');
  return { wire, reply };
}

// ── Synthetic model families (shapes as gguf-meta summarize() writes them) ─────────────────────
const base = { arch: 'llama', name: 'synthetic', contextLength: 131072, embeddingLength: 4096, blockCount: 32, headCount: 32,
  headCountKv: 8, keyLength: null, valueLength: null, keyLengthSwa: null, valueLengthSwa: null, slidingWindow: null,
  slidingWindowPattern: null, sharedKvLayers: null, fullAttentionInterval: null, ssmStateSize: null, expertCount: null,
  nextnPredictLayers: null, hasChatTemplate: true };
const pattern = (n, every = 6) => Array.from({ length: n }, (_, i) => i % every !== every - 1);
const FAMILIES = [
  base,
  { ...base, arch: 'qwen35', contextLength: 262144, headCount: 16, headCountKv: 4, keyLength: 256, valueLength: 256, fullAttentionInterval: 4, ssmStateSize: 128 },
  { ...base, arch: 'gemma4', contextLength: 131072, embeddingLength: 2560, blockCount: 42, headCount: 8, headCountKv: Array.from({ length: 42 }, (_, i) => (i % 6 === 5 ? 2 : 4)),
    keyLength: 512, valueLength: 512, keyLengthSwa: 256, valueLengthSwa: 256, slidingWindow: 512, slidingWindowPattern: pattern(42), sharedKvLayers: 18 },
  { ...base, arch: 'gemma3', contextLength: 32768, embeddingLength: 3840, blockCount: 48, headCount: 16, headCountKv: 8, keyLength: 256, valueLength: 256, slidingWindow: 1024 },
  { ...base, arch: 'qwen3moe', contextLength: 40960, embeddingLength: 2048, blockCount: 48, headCount: 32, headCountKv: 4, keyLength: 128, valueLength: 128, expertCount: 128 },
  { ...base, arch: 'glm4moe', contextLength: 131072, embeddingLength: 4096, blockCount: 46, headCount: 96, headCountKv: 8, keyLength: 128, valueLength: 128, nextnPredictLayers: 1 },
  { ...base, arch: 'nomic-bert', hasChatTemplate: false, contextLength: 2048, embeddingLength: 768, blockCount: 12, headCount: 12, headCountKv: 12 },
  { ...base, arch: 'Jina-BERT-v2', contextLength: 8192 },
  { ...base, arch: 'mystery', blockCount: null, headCount: null, headCountKv: null, embeddingLength: null },
  { ...base, contextLength: 2048 },
  { ...base, contextLength: null },
  { ...base, contextLength: 9000, headCountKv: [8, 8, 4, 4, 4] },
  { ...base, headCountKv: [], hasChatTemplate: true },
  { ...base, headCountKv: 0 },
  { ...base, arch: 'ü-модель', name: 'Grüße 😀' },
];

const OPTIONS = [
  {}, { 'ctx-size': '8192' }, { 'ctx-size': ' 16384 ' }, { 'ctx-size': '0x2000' }, { 'ctx-size': '1e4' }, { 'ctx-size': 'abc' },
  { 'ctx-size': '', c: '65536' }, { c: 32768 }, { 'ctx-size': 'Infinity' }, { 'ctx-size': '-4096' }, { 'ctx-size': '4096.5' },
  { 'cache-type-k': 'q4_0', 'cache-type-v': 'Q4_0' }, { 'cache-type-k': 'f32', 'cache-type-v': 'bf16' }, { 'cache-type-k': 'iq4_nl', 'cache-type-v': 'q5_1' },
  { 'cache-type-k': 'constructor' }, { 'cache-type-v': '__proto__' }, { 'cache-type-k': 'İ8_0' }, { 'cache-type-k': 'nope', 'cache-type-v': 8 },
  { 'cache-ram': '' }, { 'cache-ram': '-1' }, { 'cache-ram': '2048' }, { 'cache-ram': '0' }, { 'cache-ram': ' 512 ' }, { 'cache-ram': '1e3' },
  { 'cache-ram': '-0' }, { 'cache-ram': 'abc' }, { 'cache-ram': 'Infinity' }, { 'cache-ram': 4096 }, { 'cache-ram': '0b1000' }, { 'cache-ram': '　256 ' },
  { embedding: 'true' }, { embeddings: ' ON ' }, { reranking: '1' }, { rerank: 'TRUE', 'cache-ram': '-1' }, { embedding: 'false', 'cache-ram': '-1' }, { embedding: true },
  { 'ubatch-size': '2048' }, { 'ubatch-size': '256', 'batch-size': '512' }, { 'ubatch-size': '4096', 'batch-size': '2048' }, { 'batch-size': 'x' },
  { 'spec-type': 'draft-mtp' }, { 'spec-type': 'none' }, { 'ctx-size': '262144', 'cache-type-k': 'f16', 'cache-type-v': 'f16', 'cache-ram': '8192' },
];
const MODELS = [undefined, '', 'chat-model', 'nomic-Embed-text', 'bge-RERANKER', 0, 'x\ud800y'];
const BUDGETS = [14, 15, 16, 24, 6, 2, 1, 0, 0.5, 1e6, '12', '  20 ', 'x', null, true, -3];
const BYTES = [4.3 * GIB, 5.56 * GIB, 0.9 * GIB, 12 * GIB, 30 * GIB, 0, 123456789];
const MMPROJ = [undefined, 0, 0.86 * GIB, 0.3 * GIB, -1, '1000000'];
const CACHE_MAX = [undefined, 1024, 2048, 128, 0, 300, 'abc', null, '512'];

function rng(seed) {
  let x = seed >>> 0;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
}
const drop = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

function* seededSuggest(n, seed) {
  const rnd = rng(seed), pick = (xs) => xs[Math.floor(rnd() * xs.length)];
  for (let i = 0; i < n; i++) {
    const meta = { ...pick(FAMILIES) };
    if (rnd() < 0.15) meta.contextLength = pick([4096, 6000, 65536, 100000, 1048576, 2097152, null]);
    if (rnd() < 0.1) meta.nextnPredictLayers = pick([1, 2, 0, null]);
    yield drop({ meta, modelBytes: pick(BYTES), mmprojBytes: pick(MMPROJ), budgetGib: pick(BUDGETS), current: pick(OPTIONS), cacheRamMaxMib: pick(CACHE_MAX) });
  }
}
function* seededInputs(n, seed) {
  const rnd = rng(seed), pick = (xs) => xs[Math.floor(rnd() * xs.length)];
  for (let i = 0; i < n; i++) yield drop({ meta: { ...pick(FAMILIES) }, modelBytes: rnd() < 0.05 ? undefined : pick(BYTES), mmprojBytes: pick(MMPROJ), current: pick(OPTIONS) });
}
function* seededFootprint(n, seed) {
  const rnd = rng(seed), pick = (xs) => xs[Math.floor(rnd() * xs.length)];
  for (let i = 0; i < n; i++) {
    yield drop({ meta: { ...pick(FAMILIES) }, modelBytes: rnd() < 0.05 ? undefined : pick(BYTES), mmprojBytes: pick(MMPROJ),
      options: { ...pick(OPTIONS), ...(rnd() < 0.4 ? pick(OPTIONS) : {}) }, model: pick(MODELS) });
  }
}

// Hand-picked rows: every branch of suggest, as llamacpp-manager.cjs calls it.
const [LLAMA, QWEN, GEMMA4, GEMMA3, MOE, MTP, BERT] = FAMILIES;
const SUGGEST = [
  { meta: QWEN, modelBytes: 5.56 * GIB, mmprojBytes: 0.86 * GIB, budgetGib: 15, current: { 'ubatch-size': '1024' } },
  { meta: QWEN, modelBytes: 5.56 * GIB, mmprojBytes: 0.86 * GIB, budgetGib: 14, current: { 'ubatch-size': '1024' } },
  { meta: GEMMA4, modelBytes: 4.3 * GIB, mmprojBytes: 0.5 * GIB, budgetGib: 14, current: { 'batch-size': '512' }, cacheRamMaxMib: 2048 },
  { meta: GEMMA3, modelBytes: 7 * GIB, budgetGib: 16, current: { 'spec-type': 'draft-mtp' } },
  { meta: MOE, modelBytes: 17 * GIB, budgetGib: 16 }, { meta: MOE, modelBytes: 9 * GIB, budgetGib: 16 },
  { meta: MTP, modelBytes: 9 * GIB, budgetGib: 24 }, { meta: BERT, modelBytes: GIB, budgetGib: 14 },
  { meta: LLAMA, modelBytes: 40 * GIB, budgetGib: 14 }, { meta: LLAMA, modelBytes: 4 * GIB, budgetGib: 1e6 },
  { meta: { ...LLAMA, contextLength: 2048 }, modelBytes: GIB, budgetGib: 14 }, { meta: { arch: 'mystery', hasChatTemplate: true }, modelBytes: GIB, budgetGib: 14 },
  { meta: {}, modelBytes: GIB, budgetGib: 14 }, { meta: null, budgetGib: 14 }, { budgetGib: 14 }, { meta: 'x', budgetGib: 14 },
  { meta: LLAMA, modelBytes: 4 * GIB }, { meta: LLAMA, modelBytes: 4 * GIB, budgetGib: 1 }, { meta: LLAMA, modelBytes: 4 * GIB, budgetGib: '14' },
  { meta: { ...LLAMA, contextLength: 4096 }, modelBytes: 4 * GIB, budgetGib: 14, current: [] },
  { meta: { ...LLAMA, contextLength: -5 }, modelBytes: GIB, budgetGib: 14 }, { meta: { ...LLAMA, contextLength: 4095.5 }, modelBytes: GIB, budgetGib: 14 },
  { meta: { ...LLAMA, embeddingLength: 1e300, blockCount: 1e300 }, modelBytes: GIB, budgetGib: 14 },
  { meta: { ...LLAMA, keyLength: 1e308, valueLength: 1e308 }, modelBytes: GIB, budgetGib: 14 },
  { meta: { ...GEMMA4, sharedKvLayers: 42, keyLengthSwa: 1e308, valueLengthSwa: 1e308 }, modelBytes: GIB, budgetGib: 14 },
  { meta: { ...LLAMA, headCountKv: ['8', '8', true, null, 'x'] }, modelBytes: GIB, budgetGib: 14 },
  { meta: { ...LLAMA, blockCount: 4, slidingWindow: 256, slidingWindowPattern: [1, 'a', '', null], headCountKv: [0, '3', false, 2.5] }, modelBytes: GIB, budgetGib: 14 },
  { meta: { ...LLAMA, blockCount: 6, slidingWindow: 128, slidingWindowPattern: [true, false, true, false, true, false] }, modelBytes: GIB, budgetGib: 8 },
  { meta: { ...LLAMA, fullAttentionInterval: 1 }, modelBytes: GIB, budgetGib: 8 }, { meta: { ...LLAMA, fullAttentionInterval: 0.5 }, modelBytes: GIB, budgetGib: 8 },
  { meta: { ...LLAMA, sharedKvLayers: 40 }, modelBytes: GIB, budgetGib: 8 }, { meta: { ...LLAMA, sharedKvLayers: -3 }, modelBytes: GIB, budgetGib: 8 },
  { meta: { ...LLAMA, blockCount: 0.5 }, modelBytes: GIB, budgetGib: 8 }, { meta: { ...LLAMA, headCount: 3 }, modelBytes: GIB, budgetGib: 8 },
  { meta: LLAMA, modelBytes: GIB, mmprojBytes: GIB, budgetGib: 8, current: { 'ubatch-size': 'Infinity', 'batch-size': '1' } },
  { meta: LLAMA, modelBytes: GIB, budgetGib: 8, cacheRamMaxMib: 'abc' }, { meta: LLAMA, modelBytes: GIB, budgetGib: 8, cacheRamMaxMib: null },
  { meta: LLAMA, modelBytes: GIB, budgetGib: 8, cacheRamMaxMib: -100 }, { meta: LLAMA, modelBytes: GIB, budgetGib: 8, cacheRamMaxMib: 1e9 },
  { meta: { ...LLAMA, contextLength: 9007199254740991 }, modelBytes: GIB, budgetGib: 1e6 },
  { meta: { ...LLAMA, contextLength: 1048576 }, modelBytes: GIB, budgetGib: 1e6 },
  { meta: { ...LLAMA, contextLength: 1048576, nextnPredictLayers: 3 }, modelBytes: GIB, budgetGib: 9 },
];
const INPUTS = [
  { meta: QWEN, modelBytes: 5.56 * GIB, mmprojBytes: 0.86 * GIB, current: { 'ubatch-size': '1024', 'ctx-size': '65536', 'cache-type-k': 'q8_0', 'cache-ram': '2048' } },
  { meta: BERT, modelBytes: GIB }, { meta: GEMMA4, modelBytes: 4 * GIB, current: { c: '8192', 'cache-ram': '-1' } }, { meta: MOE, modelBytes: 17 * GIB },
  {}, { meta: null }, { meta: { arch: 'mystery', hasChatTemplate: true }, modelBytes: GIB, current: { 'cache-type-k': 5 } },
];
const FOOTPRINT = [
  { meta: QWEN, modelBytes: 5.56 * GIB, mmprojBytes: 0.86 * GIB, options: { 'ctx-size': '262144', 'cache-type-k': 'q8_0', 'cache-type-v': 'q8_0', 'cache-ram': '1024', 'ubatch-size': '1024' }, model: 'qwen' },
  { meta: GEMMA4, modelBytes: 4.3 * GIB, options: { 'ctx-size': '131072' }, model: 'gemma' },
  { meta: BERT, modelBytes: GIB, options: { embedding: 'on' }, model: 'nomic' }, { meta: LLAMA, modelBytes: GIB, options: { 'cache-ram': '-1' } },
  { meta: LLAMA, modelBytes: GIB, options: { 'ctx-size': 'Infinity' } }, { meta: LLAMA, modelBytes: GIB, options: { 'ctx-size': 'Infinity', 'cache-ram': '-1' } },
  { meta: LLAMA, options: {} }, {}, { options: { 'cache-type-k': 'constructor', 'cache-type-v': 'constructor' }, meta: LLAMA, modelBytes: GIB },
];

const HELPERS = [
  ...[undefined, null, '', ' ', '-1', '-0.5', '0', '256', ' 1024 ', '1e4', '0x400', '0o17', '0b101', '0X1F', '-0x1', '+12', '-Infinity', 'Infinity', 'abc', '1_0', '.5', '5.', '.', '  64 ﻿', 'ⅸ', 4096, -1, 0, true, false]
    .map((value) => [4, { value }]),
  ...[[undefined, {}], ['', {}], ['Embed', {}], ['x-reRank-y', {}], ['chat', { embedding: 'TRUE' }], ['chat', { embeddings: ' on ' }], ['chat', { reranking: 1 }],
    ['chat', { rerank: true }], ['chat', { embedding: 'yes' }], ['chat', { embedding: 'truİ' }], [5, {}], [0, { rerank: '0' }], ['chat', undefined], ['ｅｍｂｅｄ', {}], ['İmbed', {}]]
    .map(([model, options]) => [5, { model, options }]),
  ...[undefined, null, '', 0, 16, '16', '14GiB', '14 GB', '14g', ' 512 MiB ', '512m', '1.5t', '1024k', '1073741824', '2 Ti', '2 iB', '1e3', '1.5.5', '5.', '0x10', '-1g',
    'GiB', '12 kb', '7 TIB', '7 g　', 'g', '1'.repeat(400)]
    .map((value) => [6, { value }]),
];

const THROWS = [
  [1, null], [2, null], [3, null],
  [1, { meta: LLAMA, modelBytes: GIB, mmprojBytes: GIB, budgetGib: 14, current: null }],
  [1, { meta: LLAMA, modelBytes: GIB, budgetGib: 14, current: null }],
  [2, { meta: LLAMA, current: null }], [3, { meta: LLAMA, options: null }], [5, { model: 'x', options: null }],
];

const STRICT = [
  [1, { meta: { ...LLAMA, contextLength: 5000.5 }, modelBytes: GIB, budgetGib: 1e6 }],
  [1, { meta: { ...LLAMA, contextLength: 2 ** 60 }, modelBytes: GIB, budgetGib: 1e6 }],
  [1, { meta: { ...LLAMA, contextLength: '8192' }, modelBytes: GIB, budgetGib: 14 }],
  [1, { meta: { ...LLAMA, blockCount: true }, modelBytes: GIB, budgetGib: 14 }],
  [1, { meta: { ...LLAMA, arch: 5 }, modelBytes: GIB, budgetGib: 14 }],
  [1, { meta: { ...LLAMA, headCountKv: [[8]] }, modelBytes: GIB, budgetGib: 14 }],
  [1, { meta: { ...LLAMA, blockCount: 2, slidingWindow: 64, slidingWindowPattern: [{}, true] }, modelBytes: GIB, budgetGib: 14 }],
  [1, { meta: LLAMA, modelBytes: [GIB], budgetGib: 14 }], [1, { meta: LLAMA, modelBytes: GIB, budgetGib: { v: 14 } }],
  [1, { meta: LLAMA, modelBytes: GIB, mmprojBytes: GIB, budgetGib: 14, current: { 'ubatch-size': ['2048'] } }],
  [1, { meta: LLAMA, modelBytes: GIB, budgetGib: 14, cacheRamMaxMib: [1024] }],
  [1, { meta: { ...LLAMA, blockCount: 5000, slidingWindow: 64, slidingWindowPattern: Array.from({ length: 5000 }, (_, i) => i === 4999) }, modelBytes: GIB, budgetGib: 14 }],
  [2, { meta: LLAMA, current: { 'cache-ram': ['1'] } }], [2, { meta: LLAMA, current: { 'ctx-size': { n: 1 } } }],
  [3, { meta: LLAMA, options: { 'cache-type-k': ['q8_0'] } }], [3, { meta: LLAMA, options: {}, model: ['embed'] }],
  [3, { meta: LLAMA, options: { 'cache-ram': `0x${'f'.repeat(40)}` } }],
  [4, { value: ['1'] }], [4, { value: `0x${'1'.repeat(33)}` }], [5, { model: 'x', options: { embedding: [] } }], [6, { value: [16] }],
];

function throwsRow([op, args]) {
  const wire = JSON.stringify(args);
  let threw = false;
  try { OPS[op](JSON.parse(wire)); } catch { threw = true; }
  if (!threw) throw Error(`throws row did not throw: ${wire.slice(0, 80)}`);
  return { op, wire };
}
function strictRow([op, args]) {
  const wire = JSON.stringify(args);
  OPS[op](JSON.parse(wire)); // the JS answers (throws here if not)
  return { op, wire };
}

function out() {
  const suggest = [...SUGGEST, ...seededSuggest(500, 0x5eed7)].map((a) => answer(1, a));
  const inputs = [...INPUTS, ...seededInputs(150, 0x1a7e5)].map((a) => answer(2, a));
  const footprint = [...FOOTPRINT, ...seededFootprint(400, 0xf007)].map((a) => answer(3, a));
  const helpers = HELPERS.map(([op, a]) => ({ op, ...answer(op, a) }));
  return { version: 1, suggest, inputs, footprint, helpers, throws: THROWS.map(throwsRow), strict: STRICT.map(strictRow) };
}

process.stdout.write(`${JSON.stringify(out())}\n`);
