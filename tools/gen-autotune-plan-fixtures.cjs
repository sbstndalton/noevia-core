#!/usr/bin/env node
'use strict';
// Regenerates the shared fixtures for autotune's step planner (#1003). The same file is committed
// byte-for-byte in sbstndalton/noevia-rs (crates/autotune-plan/tests/fixtures/autotune-plan.v1.json);
// noevia-core CI compares them.
//   node tools/gen-autotune-plan-fixtures.cjs > tests/fixtures/autotune-plan.v1.json
//
// `expect` comes from refPlan below: an independent reference written from the planner's
// specification (crates/autotune-plan/src/lib.rs docs) with BigInt byte arithmetic. It is a test
// oracle only; noevia-core runs the Rust planner (dav-parse.wasm autotune_plan) and never this.
// Every model here is made up: the facts are shaped like common GGUF layouts (dense GQA, sliding
// window with a per-layer pattern, hybrid attention + SSM, a built-in MTP head, a projector,
// shared-KV layers), not read from any file.
//
// Sections:
//   models, memory, kv: named tables; a case's input is
//               { facts: models[model].facts, ladder: models[model].ladder, memory: memory[memory],
//                 kv: kv[kv], results }
//   runs:   { name, model, memory, kv, trace: [{ expect, outcome? }] }  seeded simulated runs. Replay:
//           results = []; for each entry, plan(input with results) must equal `expect`; then,
//           unless it is done/fail, push resultOf(expect, outcome):
//             probe/verify { step, ctx, kv, outcome }, phase { step, id, outcome },
//             serving { step, outcome }
//   errors: { name, text, pad, expect: { error } }  text + `pad` spaces must be refused

const { ladder } = require('../server/llamacpp-calibration.cjs');

const MIB = 1n << 20n, GIB = 1n << 30n;
const LIMITS = { maxInputBytes: 64 * 1024, maxLadder: 128, maxResults: 256, maxProbes: 8, maxVerify: 3 };
const BYTES32 = { f32: 128n, f16: 64n, bf16: 64n, q8_0: 34n, q5_1: 24n, q5_0: 22n, q4_1: 20n, q4_0: 18n, iq4_nl: 18n };
const PHASES = ['sampling', 'drafting', 'batch'];
const big = v => BigInt(v || 0);
const divCeil = (a, b) => (a + b - 1n) / b;
const min = (a, b) => (a < b ? a : b), max = (a, b) => (a > b ? a : b);
const sat = (a, b) => (a > b ? a - b : 0n);
const list = v => (v == null ? [] : Array.isArray(v) ? v.map(x => (typeof x === 'boolean' ? Number(x) : x)) : [v]);

function mode(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  let best = null, n = 0;
  for (const [v, c] of counts) if (c > n) { best = v; n = c; }
  return best;
}

function kvElements(f, ctxNum) {
  const ctx = big(ctxNum), layers = big(f.blockCount), heads = big(f.headCount);
  const headDim = heads ? big(f.embeddingLength) / heads : 0n;
  const hk = list(f.headCountKv);
  const kvHeads = hk.length === 0 ? heads : hk.length === 1 ? (hk[0] > 0 ? big(hk[0]) : heads) : big(mode(hk));
  const kDim = f.keyLength > 0 ? big(f.keyLength) : headDim, vDim = f.valueLength > 0 ? big(f.valueLength) : headDim;
  if (!ctx || !layers || !kvHeads || !kDim || !vDim) return null;
  const perLayerToken = kvHeads * (kDim + vDim);
  const draft = big(f.nextnPredictLayers) * perLayerToken * ctx;
  const interval = big(f.fullAttentionInterval);
  if (interval > 1n) {
    const full = max(1n, divCeil(layers, interval));
    return { elements: full * perLayerToken * ctx + draft, fixed: sat(layers, full) * 4n * MIB };
  }
  const shared = min(big(f.sharedKvLayers), layers);
  if (f.slidingWindow > 0) {
    const window = min(big(f.slidingWindow), ctx);
    const local = (f.keyLengthSwa > 0 ? big(f.keyLengthSwa) : kDim) + (f.valueLengthSwa > 0 ? big(f.valueLengthSwa) : vDim);
    const global = kDim + vDim, allocated = layers - shared;
    const pattern = list(f.slidingWindowPattern);
    if (BigInt(pattern.length) === layers) {
      let p = pattern.length;
      for (let q = 1; q <= pattern.length; q++) if (pattern.every((v, i) => v === pattern[i % q])) { p = q; break; }
      const seq = BigInt(hk.length) === layers ? hk : null;
      let sum = 0n;
      for (let i = 0; i < p; i++) {
        const h = seq ? max(1n, big(seq[i])) : kvHeads;
        sum += pattern[i] ? h * local * window : h * global * ctx;
      }
      return { elements: sum * allocated / BigInt(p) + draft, fixed: 0n };
    }
    const g = max(1n, layers / 6n), l = layers - min(g, layers);
    return { elements: (g * kvHeads * global * ctx + l * kvHeads * local * window) * allocated / layers + draft, fixed: 0n };
  }
  const own = max(1n, sat(layers, min(shared, layers - 1n)));
  return { elements: own * perLayerToken * ctx + draft, fixed: 0n };
}

function estimate(f, m, ctx, kv) {
  const e = kvElements(f, ctx);
  if (!e) return null;
  const kvBytes = divCeil(e.elements * BYTES32[kv], 32n) + e.fixed;
  let pinned = 0n;
  if (f.mmprojBytes > 0) {
    const ub = max(big(f.ubatch), 1024n);
    pinned = big(f.mmprojBytes) + GIB / 2n + divCeil(7n * (ub - 512n) * big(f.blockCount) * big(f.embeddingLength) * GIB, 1000000000n);
  }
  const engine = big(f.modelBytes) + kvBytes + pinned + GIB;
  return divCeil(engine * 21n, 20n) + big(m.cacheRamMib) * MIB;
}

const usable = m => {
  const budget = big(m.budgetMib) * MIB;
  return m.memAvailableMib == null ? budget : min(budget, sat(sat(big(m.memAvailableMib), big(m.reserveMib)), big(m.floorMib)) * MIB);
};
const fillFor = (f, ctx) => Math.max(0, Math.floor(Math.floor(ctx / Math.max(1, f.slots || 0)) * 9 / 10) - 256);
const STOP = {
  unsizeable: "Auto-tune cannot size this model's KV cache from its metadata.",
  no_rung: "No supported context size is at or below this model's trained context.",
  does_not_fit: 'This model does not fit the inference memory budget even at the smallest context size.',
  no_context: 'No context size passed the fill-and-recall test.',
  phase_failed: 'A required tuning phase failed.',
  verify_failed: 'The finished profile could not fill and recall its context.',
  serving_failed: 'The finished profile cannot serve a realistic chat request.',
};
const fail = code => ({ step: 'fail', code, message: STOP[code] });

function refPlan(input) {
  const { facts: f, memory: m, kv } = input, results = input.results || [];
  const room = usable(m);
  const fits = (c, k) => { const b = estimate(f, m, c, k); return b != null && b <= room; };
  const estMib = (c, k) => Number(divCeil(estimate(f, m, c, k), MIB));
  const rungs = input.ladder.filter(r => !f.nCtxTrain || r <= f.nCtxTrain);
  if (!rungs.length) return fail('no_rung');
  if (!kvElements(f, rungs[0])) return fail('unsizeable');
  if (!kv.some(k => fits(rungs[0], k))) return fail('does_not_fit');
  const probes = results.filter(r => r.step === 'probe').map(r => ({ c: r.ctx, k: kv.indexOf(r.kv), o: r.outcome }));
  const memory = o => o === 'oom' || o === 'load_failed';
  const banned = Math.min(Infinity, ...probes.filter(p => p.o === 'quality_failed').map(p => p.k));
  const allowed = Math.min(banned, kv.length);
  const hard = c => probes.some(p => (p.o === 'recall_failed' || p.o === 'over_time') && c >= p.c);
  const openAt = (c, k) => !hard(c) && !probes.some(p => memory(p.o) && c >= p.c && k <= p.k) && !probes.some(p => p.c === c && p.k === k);
  // #1057: one type's search: its best pass, the rungs above it that fit, and the open prefix.
  const loOf = k => { const c = probes.filter(p => p.k === k && p.o === 'passed').map(p => p.c); return c.length ? Math.max(...c) : null; };
  const ofType = k => {
    const lo = loOf(k), above = rungs.filter(c => c > (lo ?? 0) && fits(c, kv[k])), open = [];
    for (const c of above) { if (!openAt(c, k)) break; open.push(c); }
    return { lo, above, open };
  };
  const ceiling = k => rungs.filter(c => fits(c, kv[k])).at(-1) ?? null;
  // Precision first: the most precise type still in play; a more compact one replaces the choice
  // only when it fits at least twice the context.
  let pick = null;
  for (let k = 0; k < allowed; k++) {
    const cap = ceiling(k);
    if (cap == null) continue;
    const t = ofType(k);
    if (t.lo == null && !t.open.length) continue;
    if (!pick || cap >= 2 * pick.cap) pick = { k, cap, t };
  }
  const settle = chosen => {
    if (!chosen) for (let k = 0; k < allowed && !chosen; k++) { const c = loOf(k); if (c != null) chosen = { c, k }; }
    return chosen;
  };
  let ctx, k, chosenPair = null;
  if (!pick || probes.length >= LIMITS.maxProbes || !pick.t.open.length) {
    chosenPair = settle(pick && pick.t.lo != null ? { c: pick.t.lo, k: pick.k } : null);
    if (!chosenPair) return fail('no_context');
    ({ c: ctx, k } = chosenPair);
  } else {
    const { t } = pick;
    const hiKnown = t.open.length < t.above.length || probes.some(p => memory(p.o) && p.k < pick.k);
    const c = t.lo == null && !hiKnown ? t.open.at(-1) : t.open[Math.floor(t.open.length / 2)];
    return { step: 'probe', ctx: c, kv: kv[pick.k], fill: fillFor(f, c), estimateMib: estMib(c, kv[pick.k]) };
  }
  const chosen = kv[k];
  for (const id of PHASES) {
    const r = results.find(e => e.step === 'phase' && e.id === id);
    if (!r) return { step: 'phase', id, ctx, kv: chosen };
    if (r.outcome === 'failed' && id !== 'sampling') return fail('phase_failed');
  }
  const verifies = results.filter(e => e.step === 'verify');
  const ok = verifies.find(e => e.outcome === 'passed');
  if (!ok) {
    let next;
    if (!verifies.length) next = ctx;
    else if (verifies.length >= LIMITS.maxVerify) next = null;
    else { const low = Math.min(...verifies.map(e => e.ctx)); next = rungs.filter(r => r < low).at(-1) ?? null; }
    if (next == null) return fail('verify_failed');
    return { step: 'verify', ctx: next, kv: chosen, fill: fillFor(f, next), estimateMib: estMib(next, chosen) };
  }
  const serving = results.find(e => e.step === 'serving');
  if (!serving) return { step: 'serving', ctx: ok.ctx, kv: chosen };
  if (serving.outcome === 'failed') return fail('serving_failed');
  return { step: 'done', ctx: ok.ctx, kv: chosen };
}

// ── Synthetic models ────────────────────────────────────────────────────────────────────────
const GB = 1e9;
const MODELS = {
  'dense-gqa-8b': { nCtxTrain: 131072, blockCount: 32, headCount: 32, headCountKv: 8, embeddingLength: 4096, modelBytes: 4.9 * GB, slots: 1 },
  'dense-gqa-14b-32k': { nCtxTrain: 32768, blockCount: 40, headCount: 40, headCountKv: 8, embeddingLength: 5120, modelBytes: 9.0 * GB, slots: 1 },
  'swa-pattern-12b-vision': { nCtxTrain: 131072, blockCount: 48, headCount: 16, headCountKv: 8, embeddingLength: 3840, keyLength: 256, valueLength: 256,
    slidingWindow: 1024, slidingWindowPattern: Array.from({ length: 48 }, (_, i) => i % 6 !== 5), modelBytes: 7.3 * GB, mmprojBytes: 0.85 * GB, ubatch: 1024, slots: 1 },
  'swa-no-pattern-9b': { nCtxTrain: 8192, blockCount: 42, headCount: 16, headCountKv: 8, embeddingLength: 3584, keyLength: 256, valueLength: 256, slidingWindow: 4096, modelBytes: 5.8 * GB, slots: 1 },
  'swa-per-layer-heads': { nCtxTrain: 65536, blockCount: 12, headCount: 8, headCountKv: [4, 4, 4, 4, 4, 2, 4, 4, 4, 4, 4, 2], embeddingLength: 2048, keyLength: 128, valueLength: 128,
    slidingWindow: 512, slidingWindowPattern: [1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 0], modelBytes: 1.2 * GB, slots: 1 },
  'swa-shared-kv-4b': { nCtxTrain: 32768, blockCount: 30, headCount: 8, headCountKv: 2, embeddingLength: 2048, keyLength: 256, valueLength: 256, keyLengthSwa: 256, valueLengthSwa: 256,
    slidingWindow: 512, slidingWindowPattern: Array.from({ length: 30 }, (_, i) => i % 5 !== 4), sharedKvLayers: 10, modelBytes: 4.4 * GB, slots: 1 },
  'hybrid-ssm-9b': { nCtxTrain: 262144, blockCount: 32, headCount: 16, headCountKv: 4, embeddingLength: 4096, keyLength: 256, valueLength: 256, fullAttentionInterval: 4, modelBytes: 5.6 * GB, slots: 1 },
  'dense-mtp-head': { nCtxTrain: 32768, blockCount: 28, headCount: 16, headCountKv: 8, embeddingLength: 2048, keyLength: 128, valueLength: 128, nextnPredictLayers: 1, modelBytes: 2.1 * GB, slots: 1 },
  'dense-two-slots': { nCtxTrain: 65536, blockCount: 24, headCount: 16, headCountKv: 4, embeddingLength: 2048, modelBytes: 1.9 * GB, slots: 2 },
  'unknown-native': { nCtxTrain: 0, blockCount: 22, headCount: 32, headCountKv: 4, embeddingLength: 2048, modelBytes: 0.7 * GB, slots: 1 },
  'unsizeable-no-heads': { nCtxTrain: 32768, blockCount: 24, headCount: 0, embeddingLength: 2048, modelBytes: 1.5 * GB, slots: 1 },
  'short-native-2k': { nCtxTrain: 2048, blockCount: 24, headCount: 16, headCountKv: 16, embeddingLength: 2048, modelBytes: 1.1 * GB, slots: 1 },
  'too-big-30gb': { nCtxTrain: 131072, blockCount: 64, headCount: 64, headCountKv: 8, embeddingLength: 8192, modelBytes: 30 * GB, slots: 1 },
};
for (const f of Object.values(MODELS)) f.modelBytes = Math.round(f.modelBytes), f.mmprojBytes = Math.round(f.mmprojBytes || 0);
const MEMORY = {
  'budget16-avail': { budgetMib: 16384, memAvailableMib: 30000, reserveMib: 2560, floorMib: 2048, cacheRamMib: 1024 },
  'budget16-tight-avail': { budgetMib: 16384, memAvailableMib: 14000, reserveMib: 2560, floorMib: 2048, cacheRamMib: 1024 },
  'budget16-unreadable': { budgetMib: 16384, memAvailableMib: null, reserveMib: 2560, floorMib: 2048, cacheRamMib: 512 },
  'budget8': { budgetMib: 8192, memAvailableMib: 60000, reserveMib: 2560, floorMib: 2048, cacheRamMib: 1024 },
};
// #1057: bf16 then q8_0 (the floor) by default; q5 with the model's opt-in; q4_0 also behind the
// operator's override; f16 where the engine refused bf16.
const KV = { default: ['bf16', 'q8_0'], q5: ['bf16', 'q8_0', 'q5_1', 'q5_0'], below: ['bf16', 'q8_0', 'q5_1', 'q5_0', 'q4_0'], f16: ['f16', 'q8_0'] };
const COMBOS = [
  ['dense-gqa-8b', 'budget16-avail', 'default'], ['dense-gqa-8b', 'budget16-avail', 'q5'], ['dense-gqa-8b', 'budget16-avail', 'f16'],
  ['dense-gqa-8b', 'budget16-tight-avail', 'default'], ['dense-gqa-8b', 'budget16-tight-avail', 'q5'], ['dense-gqa-8b', 'budget8', 'below'],
  ['dense-gqa-14b-32k', 'budget16-avail', 'default'], ['swa-pattern-12b-vision', 'budget16-avail', 'default'], ['swa-pattern-12b-vision', 'budget16-avail', 'q5'],
  ['swa-pattern-12b-vision', 'budget8', 'below'], ['swa-no-pattern-9b', 'budget16-unreadable', 'default'],
  ['swa-per-layer-heads', 'budget16-avail', 'default'], ['swa-shared-kv-4b', 'budget16-avail', 'default'],
  ['hybrid-ssm-9b', 'budget16-avail', 'default'], ['hybrid-ssm-9b', 'budget8', 'below'], ['dense-mtp-head', 'budget16-unreadable', 'default'],
  ['dense-two-slots', 'budget16-avail', 'default'], ['unknown-native', 'budget16-avail', 'default'],
  ['unsizeable-no-heads', 'budget16-avail', 'default'], ['short-native-2k', 'budget16-avail', 'default'], ['too-big-30gb', 'budget16-avail', 'default'],
];

let seed = 0x1003;
const rand = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 32; };
const PROBE = ['passed', 'passed', 'passed', 'oom', 'load_failed', 'recall_failed', 'over_time', 'quality_failed'];
const OUTCOME = ['passed', 'passed', 'passed', 'skipped', 'failed'];
const pick = a => a[Math.floor(rand() * a.length)];
const SCRIPTS = { 'all-pass': () => 'passed', 'seeded-a': null, 'seeded-b': null, 'seeded-c': null };

const runs = [];
for (const [model, mem, kvName] of COMBOS) {
  for (const [script, fixed] of Object.entries(SCRIPTS)) {
    const input = { facts: MODELS[model], memory: MEMORY[mem], ladder: ladder(MODELS[model].nCtxTrain), kv: KV[kvName], results: [] };
    const trace = [];
    for (let n = 0; n < 24; n++) {
      const expect = refPlan(input);
      if (expect.step === 'done' || expect.step === 'fail') { trace.push({ expect }); break; }
      const outcome = fixed ? fixed() : ['probe', 'verify'].includes(expect.step) ? pick(PROBE) : pick(OUTCOME);
      trace.push({ expect, outcome });
      const r = { step: expect.step, outcome };
      if (expect.step === 'probe' || expect.step === 'verify') Object.assign(r, { ctx: expect.ctx, kv: expect.kv });
      if (expect.step === 'phase') r.id = expect.id;
      input.results.push(r);
    }
    runs.push({ name: `${model} / ${mem} / ${kvName} / ${script}`, model, memory: mem, kv: kvName, trace });
    if (['unsizeable-no-heads', 'short-native-2k', 'too-big-30gb'].includes(model)) break;
  }
}

const valid = { facts: MODELS['dense-gqa-8b'], memory: MEMORY['budget16-avail'], ladder: [4096, 8192], kv: ['bf16'] };
const variant = patch => JSON.stringify({ ...valid, ...patch });
const errors = [
  { name: 'not JSON', text: '{', pad: 0, expect: { error: 'input' } },
  { name: 'too large', text: JSON.stringify(valid), pad: LIMITS.maxInputBytes, expect: { error: 'too_large' } },
  { name: 'ladder not increasing', text: variant({ ladder: [8192, 4096] }), pad: 0, expect: { error: 'input' } },
  { name: 'ladder rung not a number', text: variant({ ladder: ['4096'] }), pad: 0, expect: { error: 'input' } },
  { name: 'ladder rung too small', text: variant({ ladder: [128] }), pad: 0, expect: { error: 'input' } },
  { name: 'ladder too long', text: variant({ ladder: Array.from({ length: 129 }, (_, i) => 4096 + i) }), pad: 0, expect: { error: 'input' } },
  { name: 'unknown cache type', text: variant({ kv: ['q2_k'] }), pad: 0, expect: { error: 'input' } },
  { name: 'duplicate cache type', text: variant({ kv: ['bf16', 'bf16'] }), pad: 0, expect: { error: 'input' } },
  { name: 'negative fact', text: variant({ facts: { blockCount: -1 } }), pad: 0, expect: { error: 'input' } },
  { name: 'fractional fact', text: variant({ facts: { blockCount: 1.5 } }), pad: 0, expect: { error: 'input' } },
  { name: 'string fact', text: variant({ facts: { blockCount: '32' } }), pad: 0, expect: { error: 'input' } },
  { name: 'no memory', text: JSON.stringify({ facts: {}, ladder: [4096], kv: ['bf16'] }), pad: 0, expect: { error: 'input' } },
  { name: 'result kv not offered', text: variant({ results: [{ step: 'probe', ctx: 4096, kv: 'q8_0', outcome: 'passed' }] }), pad: 0, expect: { error: 'input' } },
  { name: 'unknown step', text: variant({ results: [{ step: 'guess', outcome: 'passed' }] }), pad: 0, expect: { error: 'input' } },
  { name: 'unknown outcome', text: variant({ results: [{ step: 'probe', ctx: 4096, kv: 'bf16', outcome: 'maybe' }] }), pad: 0, expect: { error: 'input' } },
  { name: 'unknown phase', text: variant({ results: [{ step: 'phase', id: 'kv', outcome: 'passed' }] }), pad: 0, expect: { error: 'input' } },
  { name: 'too many results', text: variant({ results: Array.from({ length: 257 }, () => ({ step: 'serving', outcome: 'passed' })) }), pad: 0, expect: { error: 'input' } },
];

const models = Object.fromEntries(Object.entries(MODELS).map(([name, facts]) => [name, { facts, ladder: ladder(facts.nCtxTrain) }]));
process.stdout.write(`${JSON.stringify({ version: 1, limits: LIMITS, models, memory: MEMORY, kv: KV, runs, errors }, null, 1)}\n`);
