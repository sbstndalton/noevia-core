#!/usr/bin/env node
'use strict';
// Regenerates the shared fixtures for LLAMACPP_PRESETS_IMPL: llamacpp-presets.cjs's preset option
// check (with inference-budget.cjs's cache-ram clamp), canonicalOptions, the micro-batch check and
// the model name pattern. The same file is committed byte-for-byte in sbstndalton/noevia-rs
// (crates/llamacpp-presets/tests/fixtures/llamacpp-presets.v1.json); noevia-core CI compares them.
//   node tools/gen-llamacpp-presets-fixtures.cjs > tests/fixtures/llamacpp-presets.v1.json
//
// Each row is { op, wire, want }: `wire` is the JSON the host sends after the op byte, `want` the
// exact reply text the port must give, which is the JS's own answer. Rows marked `strict` hold the
// port's deliberately stricter answer instead (it refuses where the JS accepts), and this script
// checks that each one only ever refuses more:
//   - op 1, cache-ram with a hard maximum that is not a safe non-negative integer: null;
//   - op 3, a 0x/0o/0b number wider than 53 bits: undecided (null), which the host refuses.
// Nothing here depends on ICU: the only non-ASCII handling is String#trim's fixed white-space
// list (the differential test checks every UTF-16 code unit against the runtime's own), and every
// other pattern is ASCII. All values are synthetic; random combinations use a seeded mulberry32.

const path = require('node:path');
const p = require(path.join(__dirname, '..', 'server', 'llamacpp-presets.cjs'));

function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(0x11a3ac99);
const pick = (list) => list[Math.floor(rand() * list.length)];

const rows = [];
const seen = new Set();
function push(op, args, want, strict) {
  const wire = JSON.stringify(args);
  const key = `${op}:${wire}`;
  if (seen.has(key)) return;
  seen.add(key);
  rows.push({ op, wire, want: JSON.stringify(want), ...(strict ? { strict: true } : {}) });
}

const MAX_SAFE = 2n ** 53n - 1n;
const safeHard = (h) => typeof h === 'number' && Number.isSafeInteger(h) && h >= 0;
const hardWire = (h) => (typeof h === 'number' && Number.isFinite(h) ? h : null);

// ── values ──────────────────────────────────────────────────────────────────
const KEYS = [...Object.keys(p.fields), ...Object.values(p.fields).flatMap((f) => f.aliases),
  'model', 'mmproj', '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'CTX-SIZE', 'Temp', ' ctx-size', 'ctx-size ', '--ctx-size', '-c', '---c',
  ' c', 'c ', '﻿ctx-size', 'ctx_size', '', '-', '--', 'cache-ram\u0000', 'cache‐ram', 'ć'];
const VALUES = ['', '0', '00', '1', '01', '2', '5', '9', '16', '17', '31', '32', '33', '63', '64', '65', '100', '999', '1000', '2047', '2048', '2049',
  '4096', '8192', '8193', '16384', '16385', '32768', '100000', '100001', '1048575', '1048576', '1048577', '0001048576', '00000000000000000000000002048',
  '9'.repeat(30), '1' + '0'.repeat(400), '-1', '-0', '-00', '-2048', '-', '+5', '+0', ' 5', '5 ', '\t64\n', ' 64', '64　', '﻿64',
  '᠎64', '​64', '64 ', '5.', '.5', '0.5', '0.50', '0.500', '0.5000', '1.0', '1.00', '1.000', '1.0000', '1.001', '1.1', '2.0', '2.000', '2.001',
  '3.000', '3.001', '0.999', '0.0', '0.000', '0.001', '00.5', '1e3', '1E3', '0x10', '0X10', '0o10', '0b10', '1_000', '١٢٣', '１２３', '٣', '5\n', '5\r',
  'auto', 'all', 'Auto', 'AUTO', 'all ', 'on', 'off', 'On', 'q8_0', 'Q8_0', 'q8_0 ', 'f16', 'bf16', 'iq4_nl', 'q5_1', 'q6_k', 'none', 'draft-mtp',
  'ngram-simple', 'draft-mtp,ngram-simple', 'ngram-simple,draft-mtp', 'draft-mtp, ngram-simple', 'NaN', 'Infinity', 'true', 'null', 'x', '64\nmodel = /evil',
  '\ud800', 'q8_0\udc00', '1048576\u0000'];
const CACHE_VALUES = ['-1', ' -1 ', '-0', '-00', '-12', '0', '000', '12', '0012', ' 12 ', '　 12 ', '᠎12', '12​', '2048', '2049', '1048576',
  '1048577', '99999999999', '9'.repeat(40), '-' + '9'.repeat(40), '1' + '0'.repeat(320), '+12', '12.0', '1e3', '0x10', '--1', '- 1', '12 13', '١٢', ''];
const HARDS = [2048, 0, 1, 1024, 1048576, 1048577, 4096, 2 ** 53 - 1, 2 ** 53, 1.5, -1, -0, 1e21, NaN, Infinity, undefined];

function op1(pairs, hard) {
  const limits = { capMib: 1024, hardMaxMib: hard };
  const js = pairs.map(([k, v]) => p.optionValue(k, v, limits) ?? null);
  const port = pairs.map(([k, v], i) => (k === 'cache-ram' && v !== '' && !safeHard(hard) ? null : js[i]));
  const strict = port.some((v, i) => v !== js[i]);
  if (strict && port.some((v, i) => v !== null && v !== js[i])) throw Error('a strict row must only refuse more');
  push(1, [pairs, hardWire(hard)], { values: port }, strict);
}

for (const k of KEYS) for (const v of VALUES) op1([[k, v]], 2048);
for (const v of [...CACHE_VALUES, ...VALUES]) for (const h of HARDS) op1([['cache-ram', v]], h);
for (const h of HARDS) op1([['ctx-size', '4096'], ['cache-ram', '512'], ['temp', '0.7']], h);
for (let i = 0; i < 600; i++) {
  const n = 1 + Math.floor(rand() * 6), pairs = [];
  for (let j = 0; j < n; j++) pairs.push([rand() < 0.7 ? pick(Object.keys(p.fields)) : pick(KEYS), rand() < 0.3 ? pick(CACHE_VALUES) : pick(VALUES)]);
  op1(pairs, rand() < 0.85 ? pick([2048, 1024, 4096]) : pick(HARDS));
}

// ── canonicalOptions ────────────────────────────────────────────────────────
const RAW_KEYS = [...KEYS, '  --cram ', '　-ngl', '- c', '- c', 'LLAMA_ARG_CACHE_RAM ', '\t--LLAMA_ARG_CTX_SIZE\n', '--np', '---', ' fa ',
  '᠎c', 'c​', '--c--', '-–c'];
function op2(pairs) {
  push(2, [pairs], { options: pairs.map(([k, v]) => p.canonicalEntry(k, v)) });
}
for (const k of RAW_KEYS) for (const v of ['5', ' 5 ', null, '', '  x﻿', '᠎5', '5​']) op2([[k, v]]);
for (const v of [...VALUES, ...CACHE_VALUES]) op2([['ctx-size', v], ['c', v]]);
for (let i = 0; i < 300; i++) {
  const n = 1 + Math.floor(rand() * 5), pairs = [];
  for (let j = 0; j < n; j++) pairs.push([pick(RAW_KEYS), rand() < 0.1 ? null : pick(VALUES)]);
  op2(pairs);
}

// ── micro-batch check ───────────────────────────────────────────────────────
/** What the port decides: Number(s), or undefined where it does not decide (a 0x/0o/0b literal
 *  that passes 53 bits before any invalid digit). */
function portNumber(s) {
  if (s === null) return NaN;
  const t = s.trim(), m = /^0([xXoObB])([\s\S]*)$/.exec(t);
  if (!m) return Number(t);
  const radix = { x: 16, o: 8, b: 2 }[m[1].toLowerCase()];
  if (!m[2]) return NaN;
  let n = 0n;
  for (const ch of m[2]) {
    const d = parseInt(ch, radix);
    if (!(d >= 0) || ch.length !== 1 || !/^[0-9a-zA-Z]$/.test(ch)) return NaN;
    n = n * BigInt(radix) + BigInt(d);
    if (n > MAX_SAFE) return undefined;
  }
  return Number(t);
}
const NUMBERS = ['', ' ', ' ', '0', '-0', '+0', '32', '64', '65', '0064', '64.', '.64e2', '6.4e1', '640e-1', '64e', '64e+', '6e+1', '+64', '-64', '++64',
  '0x40', '0X40', '0x41', '0o100', '0O101', '0b1000000', '0B1000001', '-0x40', '+0x40', '0x', '0x4g', '0x 40', '0b2', '0o8', '64n', '6_4', '6,4',
  'Infinity', '+Infinity', '-Infinity', 'infinity', 'INFINITY', 'Inf', 'NaN', '1e400', '-1e400', '1e-400', '﻿64', '᠎64', '​64', '64　',
  '\t64\n', '  65  ', '٦٤', '６４', '9007199254740992', '9007199254740993', '9007199254740994', '0x1fffffffffffff', '0x20000000000000',
  '0x' + 'f'.repeat(20), '0b' + '1'.repeat(53), '0b' + '1'.repeat(54), '0o' + '7'.repeat(18), '0o' + '7'.repeat(17) + '8', '0x' + 'f'.repeat(14) + 'g',
  '0x00000000000000000000000000040', '1' + '0'.repeat(400), '0.' + '0'.repeat(400) + '1', '64' + '0'.repeat(30) + 'e-30',
  '2.4703282292062327e-324', '2.4703282292062328e-324', '1.7976931348623157e308', '1.7976931348623159e308', '0.1e1', '.', '+.', '-.5', '5.e1', '.e1'];
function op3(u, b) {
  const js = p.microBatchExceeds(u ?? undefined, b ?? undefined);
  const pu = portNumber(u), pb = portNumber(b);
  const port = pu === undefined || pb === undefined ? null : pu > pb;
  if (port !== null && port !== js) throw Error(`the port model disagrees with the JS: ${u} ${b}`);
  push(3, [u, b], { exceeds: port }, port === null);
}
for (const u of [...NUMBERS, null]) for (const b of ['64', '0x40', null, '', 'NaN', '1e400', '9007199254740992']) op3(u, b);
for (const b of NUMBERS) op3('64', b);
for (let i = 0; i < 500; i++) op3(rand() < 0.1 ? null : pick(NUMBERS), rand() < 0.1 ? null : pick(NUMBERS));

// ── model names ─────────────────────────────────────────────────────────────
const MODELS = ['m', 'gemma-3-12b', 'org/model.gguf', 'org/model:Q4_K_M', 'a'.repeat(200), 'a'.repeat(201), '', ' ', 'a b', 'a\nb', 'a\n', '\na', 'ü', 'model ',
  '../x', 'x]', '[x', '*', 'a;b', 'a=b', 'a#b', 'm\u0000', '\ud800', 'm ', 'MODEL_1.2-3/4:5', '٣', 'ｍ'];
for (const m of MODELS) push(4, [m], { ok: p.modelNameOk(m) });

process.stdout.write(JSON.stringify({
  note: 'Generated by noevia-core tools/gen-llamacpp-presets-fixtures.cjs from llamacpp-presets.cjs itself; byte-identical in noevia-rs.',
  rows,
}) + '\n');
