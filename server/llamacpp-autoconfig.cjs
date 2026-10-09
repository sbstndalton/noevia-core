'use strict';
// Native preset suggestions: the largest context that fits the inference memory budget,
// plus the runtime knobs that follow from the model file. The KV/projector sizing is a
// port of scratchhax/model-loader (MIT, e11a6ec, app/autoconfig.py), reduced to one
// device and to the fields noevia's preset editor accepts. Suggestions are never
// applied here; they go through the normal preset editor, CAS and reload path.
//
// Checked against this host's 2026-09-12/13 calibration peaks (GPU VRAM + GTT, less the
// idle baseline). Raw estimates were 12.7 vs 13.2 GiB (Qwen3.5 9B UD-Q4_K_XL, 262144 ctx,
// mmproj, ub 1024) and 8.5 vs 8.6 GiB (Gemma 4 E4B Q4_K_M, 131072 ctx, mmproj), so totals
// carry a 5% margin; both verified profiles still fit the 14 GiB limit they passed under.

// Kept identical to _CTX_CANDIDATES in services/model-manager/app/autoconfig.py,
// which is the planner. The calibrator below walks THIS list, so any value the
// planner can recommend and this list lacks is a context noevia will suggest and
// can never verify. They had drifted by six values; llamacpp-autoconfig.test.cjs
// now parses the Python and fails if they diverge again.
const CTX_CANDIDATES = [
  4096, 8192, 12288, 16384, 24576, 32768, 40960, 49152, 57344, 65536, 73728, 81920,
  90112, 98304, 106496, 114688, 122880, 131072, 139264, 147456, 151552, 155648, 159744, 163840,
  172032, 180224, 188416, 196608, 204800, 212992, 221184, 229376, 237568, 245760, 253952, 262144,
  294912, 327680, 360448, 393216, 425984, 458752, 491520, 524288, 589824, 655360, 720896, 786432,
  851968, 917504, 983040, 1048576,
];
const Q8_BYTES = 1.0625;           // q8_0 bytes per element; K and V both stay q8_0
const RESERVE_GIB = 1.0;           // runtime, driver context and compute scratch
const SSM_STATE_BYTES = 4 * 1024 * 1024; // recurrent state per SSM layer (hybrid models)
const MMPROJ_COMPUTE_GIB = 0.5;    // vision encoder scratch beyond projector weights
const IMAGE_MAX_TOKENS = 1024;     // bounds per-image decode memory; ubatch must cover it
const SAFETY = 1.05;              // raw estimate ran 4% under the measured Qwen 9B peak
const GIB = 1024 ** 3;
// Bytes per KV element per cache type (llama.cpp block layouts); f16 is llama.cpp's default.
const KV_TYPE_BYTES = { f32: 4, f16: 2, bf16: 2, q8_0: 1.0625, q5_1: 0.75, q5_0: 0.6875, q4_1: 0.625, q4_0: 0.5625, iq4_nl: 0.5625 };
// llama-server's own --cache-ram default (MiB) when a preset sets none (#697).
const LLAMA_CACHE_RAM_DEFAULT_MIB = 8192;

const scalar = v => (typeof v === 'number' && v > 0 ? v : null);
function kvHeadsOf(value, fallback) {
  if (typeof value === 'number' && value > 0) return value;
  if (Array.isArray(value) && value.length) {
    const counts = new Map();
    for (const v of value) counts.set(v, (counts.get(v) || 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1])[0][0];
  }
  return fallback;
}
function periodOf(seq) {
  for (let p = 1; p <= seq.length; p++) if (seq.every((v, i) => v === seq[i % p])) return p;
  return seq.length;
}

// Bytes of KV cache (plus recurrent state) for `ctx` tokens.
function kvCacheBytes(m, ctx) {
  const layers = m.blockCount || 0, heads = m.headCount || 0;
  const headDim = heads ? Math.floor((m.embeddingLength || 0) / heads) : 0;
  const kvHeads = kvHeadsOf(m.headCountKv, heads);
  const kDim = scalar(m.keyLength) || headDim, vDim = scalar(m.valueLength) || headDim;
  if (!(ctx > 0 && layers > 0 && kvHeads > 0 && kDim > 0 && vDim > 0)) return 0;
  const perLayerToken = kvHeads * (kDim + vDim) * Q8_BYTES;
  // Hybrid attention + SSM (Qwen3.5): only every Nth layer keeps a growing KV cache.
  const interval = m.fullAttentionInterval;
  if (interval && interval > 1) {
    const full = Math.max(1, Math.ceil(layers / interval));
    return full * perLayerToken * ctx + (layers - full) * SSM_STATE_BYTES;
  }
  const shared = Math.max(0, Math.min(m.sharedKvLayers || 0, layers));
  // Sliding window (Gemma): local layers hold a short window, global layers the full ctx,
  // and shared-KV layers allocate nothing of their own.
  if (m.slidingWindow && m.slidingWindow > 0) {
    const allocFrac = (layers - shared) / layers;
    const localElem = ((scalar(m.keyLengthSwa) || kDim) + (scalar(m.valueLengthSwa) || vDim)) * Q8_BYTES;
    const globalElem = (kDim + vDim) * Q8_BYTES;
    const window = Math.min(m.slidingWindow, ctx);
    const pattern = Array.isArray(m.slidingWindowPattern) && m.slidingWindowPattern.length === layers ? m.slidingWindowPattern : null;
    const headSeq = Array.isArray(m.headCountKv) && m.headCountKv.length === layers ? m.headCountKv : null;
    if (pattern) {
      const period = periodOf(pattern), reps = (layers / period) * allocFrac;
      let total = 0;
      for (let i = 0; i < period; i++) {
        const h = headSeq ? Math.max(1, headSeq[i]) : kvHeads;
        total += pattern[i] ? reps * h * localElem * window : reps * h * globalElem * ctx;
      }
      return total;
    }
    const global = Math.max(1, Math.floor(layers / 6)), local = layers - global;
    return allocFrac * (global * kvHeads * globalElem * ctx + local * kvHeads * localElem * window);
  }
  return Math.max(1, layers - Math.min(shared, layers - 1)) * perLayerToken * ctx;
}

// Built-in MTP heads (nextn layers) run a draft context with its own KV at full ctx.
function draftKvBytes(m, ctx) {
  const n = m.nextnPredictLayers || 0;
  if (!n || !m.blockCount) return 0;
  const perLayer = kvCacheBytes({ ...m, blockCount: 1, fullAttentionInterval: null, slidingWindow: null, sharedKvLayers: 0 }, ctx);
  return n * perLayer;
}

const round2 = n => Math.round(n * 100) / 100;

/**
 * @param {object} p
 * @param {object} p.meta      gguf-meta summarize() output
 * @param {number} p.modelBytes model file size
 * @param {number} [p.mmprojBytes] projector file size when the preset names one
 * @param {number} p.budgetGib  inference memory budget (GPU-addressable, shared)
 * @param {object} [p.current]  current section options
 * @param {number} [p.cacheRamMaxMib]
 */
function suggestJs({ meta, modelBytes, mmprojBytes = 0, budgetGib, current = {}, cacheRamMaxMib = 1024 }) {
  const m = meta || {};
  if (!(budgetGib > RESERVE_GIB)) return { error: 'No inference memory budget is configured to size against.' };
  if (!m.hasChatTemplate || /bert/i.test(m.arch || '')) return { error: 'Suggestions cover chat models only. Embedding and projector files keep their qualified settings.' };
  if (kvCacheBytes(m, 4096) <= 0) return { error: `Cannot size the KV cache from this model's metadata (${m.arch || 'unknown architecture'}). Set the context manually and load-test it.` };
  if (m.expertCount && m.expertCount > 1 && modelBytes / GIB > budgetGib - RESERVE_GIB) return { error: 'This mixture-of-experts model needs CPU expert offload, which the preset editor does not manage. Use a smaller quantization or configure offload manually.' };

  const modelGib = modelBytes / GIB;
  const hasMmproj = mmprojBytes > 0;
  let pinnedGib = 0;
  if (hasMmproj) {
    const ubatch = Math.max(IMAGE_MAX_TOKENS, Number(current['ubatch-size']) || 0);
    // Larger micro-batches grow the non-split compute buffer; charge only the increase over 512.
    pinnedGib = mmprojBytes / GIB + MMPROJ_COMPUTE_GIB + 7 * Math.max(0, ubatch - 512) * (m.blockCount || 0) * (m.embeddingLength || 0) / 1e9;
  }
  const native = m.contextLength || 0;
  // Only offer context sizes the calibrator actually load-tests; snap to the largest qualified
  // candidate at or below the model's native context instead of proposing the raw native value.
  // If native sits below every qualified rung (e.g. an old 2048-ctx model), there is nothing
  // verified to fall back to: report that plainly instead of silently suggesting an unverified
  // context, and instead of letting an empty candidate list masquerade as "needs more memory".
  if (native && native < CTX_CANDIDATES[0]) {
    return { error: `This model's native context (${native}) is below the smallest supported context size (${CTX_CANDIDATES[0]}). Set the context manually and load-test it.` };
  }
  const candidates = CTX_CANDIDATES.filter(c => !native || c <= native).sort((a, b) => a - b);
  // #697: the prompt cache (--cache-ram) is host RAM spent on inference too, so each row is
  // sized with the largest cache this suggestion may write; the estimate then never exceeds
  // the budget whatever cache size is chosen below.
  const cacheGib = Math.max(0, Number(cacheRamMaxMib) || 0) / 1024;
  const rows = candidates.map(ctx => {
    const kvGib = (kvCacheBytes(m, ctx) + draftKvBytes(m, ctx)) / GIB;
    const totalGib = (modelGib + kvGib + pinnedGib + RESERVE_GIB) * SAFETY + cacheGib;
    return { ctx, modelGib: round2(modelGib), kvGib: round2(kvGib), extraGib: round2(pinnedGib + RESERVE_GIB), cacheRamGib: round2(cacheGib), totalGib: round2(totalGib), fits: totalGib <= budgetGib };
  });
  const fitting = rows.filter(r => r.fits);
  if (!fitting.length) return { error: `This model needs about ${round2((modelGib + pinnedGib + RESERVE_GIB) * SAFETY + cacheGib)} GiB before any context, more than the ${budgetGib} GiB budget. Use a smaller quantization.`, rows, budgetGib };
  const best = fitting.at(-1);

  const values = { 'ctx-size': String(best.ctx), parallel: '1', 'n-gpu-layers': '999', 'flash-attn': 'on', 'cache-type-k': 'q8_0', 'cache-type-v': 'q8_0' };
  const notes = [];
  // Bounded prompt cache: host RAM here is also GPU memory, so stay at the qualified cap.
  const convoMib = Math.round((kvCacheBytes(m, best.ctx) / GIB) * 4 * 1024);
  values['cache-ram'] = String(Math.max(256, Math.min(convoMib, cacheRamMaxMib)));
  if (hasMmproj) {
    values['image-max-tokens'] = String(IMAGE_MAX_TOKENS);
    // Non-causal vision batches cannot be split: ubatch must cover a whole image.
    values['ubatch-size'] = String(Math.max(IMAGE_MAX_TOKENS, Number(current['ubatch-size']) || 0));
    const batch = Number(current['batch-size']) || 0;
    if (batch && batch < Number(values['ubatch-size'])) values['batch-size'] = values['ubatch-size'];
  }
  if (m.nextnPredictLayers > 0) {
    values['spec-type'] = 'draft-mtp';
    notes.push('The model file includes a multi-token prediction head, so speculative decoding uses it.');
  } else if (current['spec-type'] === 'draft-mtp') {
    values['spec-type'] = 'none';
    notes.push('No prediction head found in this model file, so MTP is turned off.');
  }
  if (native && best.ctx === native) notes.push(`Context is the model's trained maximum (${native.toLocaleString('en-US')} tokens).`);
  else notes.push(`Context is limited by memory; the model supports ${native ? native.toLocaleString('en-US') : 'an unknown number of'} tokens.`);
  if (!hasMmproj) notes.push('No vision projector is configured, so image limits are left unchanged.');
  notes.push('Estimates cover one conversation slot. Load the model and test a long prompt before relying on the full allocation.');
  return { values, rows, budgetGib, estimateGib: best.totalGib, notes, source: 'Adapted from Model Loader autoconfig (scratchhax/model-loader, MIT).' };
}

/**
 * The read-only ingredients of the memory estimate, for the guided "Will it fit?" panel (#204).
 * KV rows are sized at q8_0 (the cache type suggest() uses); the client rescales them per
 * cache type. Nothing here depends on the budget, so it is safe to return without one.
 */
function estimateInputsJs({ meta, modelBytes, mmprojBytes = 0, current = {} }) {
  const m = meta || {};
  const chat = !!m.hasChatTemplate && !/bert/i.test(m.arch || '');
  let pinnedGib = 0;
  if (mmprojBytes > 0) {
    const ubatch = Math.max(IMAGE_MAX_TOKENS, Number(current['ubatch-size']) || 0);
    pinnedGib = mmprojBytes / GIB + MMPROJ_COMPUTE_GIB + 7 * Math.max(0, ubatch - 512) * (m.blockCount || 0) * (m.embeddingLength || 0) / 1e9;
  }
  const native = m.contextLength || 0;
  const sizeable = kvCacheBytes(m, 4096) > 0;
  const rows = sizeable ? CTX_CANDIDATES.filter(c => !native || c <= native).map(ctx => ({ ctx, kvQ8Gib: round2((kvCacheBytes(m, ctx) + draftKvBytes(m, ctx)) / GIB) })) : [];
  const currentCtx = Number(current['ctx-size'] || current.c) || null;
  const currentKv = typeof current['cache-type-k'] === 'string' ? current['cache-type-k'] : null;
  return { chat, sizeable, arch: m.arch || '', nativeCtx: native || null, modelGib: round2(modelBytes / GIB), pinnedGib: round2(pinnedGib),
    reserveGib: RESERVE_GIB, safety: SAFETY, moe: !!(m.expertCount && m.expertCount > 1), rows, current: { ctx: currentCtx, kv: currentKv },
    // #697: the preset's prompt cache counts against the inference budget too (null: unbounded).
    cacheRamGib: Number.isFinite(cacheRamMibOf(current['cache-ram'])) ? round2(cacheRamMibOf(current['cache-ram']) / 1024) : null };
}

/** Embedding or reranking preset, by its flags or its name (as chat-model-kind.cjs judges names). */
function isPromptCacheFree(model, options = {}) {
  const on = key => ['true', '1', 'on'].includes(String(options[key] ?? '').trim().toLowerCase());
  return on('embedding') || on('embeddings') || on('reranking') || on('rerank') || /embed|rerank/i.test(String(model || ''));
}

/** Prompt-cache MiB a preset value means: unset is llama-server's 8192 default, -1 unbounded. */
function cacheRamMibOf(value) {
  const text = value == null ? '' : String(value).trim();
  if (text === '') return LLAMA_CACHE_RAM_DEFAULT_MIB;
  const n = Number(text);
  if (!Number.isFinite(n)) return LLAMA_CACHE_RAM_DEFAULT_MIB;
  return n < 0 ? Infinity : n;
}

/**
 * #697: what loading one preset costs in inference memory (GPU-visible memory, which on an APU
 * is GTT in system RAM, plus the host-RAM prompt cache). Uses the same KV/projector estimators
 * as suggest(), at the preset's own context and cache types:
 *   total = (weights + KV(ctx, cache types) + draft KV + projector + 1 GiB runtime) x 1.05
 *           + cache-ram
 * `options` are the effective preset options ({...'*', ...section}).
 */
function estimateFootprintJs({ meta, modelBytes, mmprojBytes = 0, options = {}, model = '' }) {
  const m = meta || {};
  const native = m.contextLength || 0;
  const ctx = Number(options['ctx-size'] || options.c) || native || 4096;
  const typeBytes = t => KV_TYPE_BYTES[String(t || 'f16').toLowerCase()] || KV_TYPE_BYTES.f16;
  const kvScale = (typeBytes(options['cache-type-k']) + typeBytes(options['cache-type-v'])) / 2 / Q8_BYTES;
  const sizeable = kvCacheBytes(m, 4096) > 0;
  const kvGib = sizeable ? (kvCacheBytes(m, ctx) + draftKvBytes(m, ctx)) * kvScale / GIB : 0;
  let pinnedGib = 0;
  if (mmprojBytes > 0) {
    const ubatch = Math.max(IMAGE_MAX_TOKENS, Number(options['ubatch-size']) || 0);
    pinnedGib = mmprojBytes / GIB + MMPROJ_COMPUTE_GIB + 7 * Math.max(0, ubatch - 512) * (m.blockCount || 0) * (m.embeddingLength || 0) / 1e9;
  }
  const modelGib = (Number(modelBytes) || 0) / GIB;
  // #723: llama-server keeps a prompt cache only for completion slots, so embedding and
  // reranking sections cost no cache-ram whatever the preset (or the 8 GiB default) says.
  const cacheMib = isPromptCacheFree(model, options) ? 0 : cacheRamMibOf(options['cache-ram']);
  const cacheRamGib = cacheMib === Infinity ? Infinity : cacheMib / 1024;
  const engineGib = (modelGib + kvGib + pinnedGib + RESERVE_GIB) * SAFETY;
  const totalGib = engineGib + cacheRamGib;
  return { ctx, modelGib: round2(modelGib), kvGib: round2(kvGib), extraGib: round2(pinnedGib + RESERVE_GIB),
    cacheRamGib: cacheRamGib === Infinity ? null : round2(cacheRamGib), cacheRamUnbounded: cacheRamGib === Infinity,
    totalGib: totalGib === Infinity ? null : round2(totalGib), sizeable };
}

function parseMemoryLimit(value) {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([kmgt]?)i?b?\s*$/i.exec(String(value || ''));
  if (!match) return null;
  const scale = { '': 1 / GIB, k: 1 / (1024 ** 2), m: 1 / 1024, g: 1, t: 1024 }[match[2].toLowerCase()];
  return Number(match[1]) * scale;
}

// ── Rust confirmation (LLAMACPP_AUTOCONFIG_IMPL, retired in #1071: always on) ────────────────
// suggest, estimateInputs and estimateFootprint also ask noevia-rs's llamacpp-autoconfig crate
// (dav-parse.wasm llamacpp_autoconfig). The JS (suggestJs and friends) stays authoritative:
// its answer is returned as is when the port's reply is byte-identical to JSON.stringify of it. When
// the port refuses, faults or disagrees, the JS answer is still returned if it is the conservative
// one (logged once per reason, text-free):
//   suggest           the JS offered no settings (an error), or every sized knob (ctx-size,
//                     cache-ram, n-gpu-layers, parallel, ubatch/batch-size, image-max-tokens) is at
//                     most the port's and the rest (cache types, flash-attn, spec-type) are equal;
//   estimateFootprint the JS estimate already refuses the load (unbounded prompt cache, or a NaN
//                     total), or its total is at least the port's, the port's prompt cache is
//                     bounded and the port can size every model the JS sizes;
//   estimateInputs    every JS figure (model, projector, each KV row, prompt cache) is at least the
//                     port's, over the same context rows, with chat, moe, nativeCtx and the current
//                     ctx and kv equal (noevia#1134).
// Otherwise suggest returns an error (no settings, code 'autoconfig_impl') and the two estimates
// throw an AutoconfigImplError, which llamacpp-manager.cjs turns into a refused load or save (or a
// 503 for the read-only panel). So the port never makes a suggestion or a load larger than the JS
// would, and nothing here loads a model. When the JS throws, the port is not asked. A missing or
// tampered dav-parse.wasm stops startup.
// cacheRamMibOf, isPromptCacheFree, parseMemoryLimit and kvCacheBytes are ported too (and checked by
// the differential tests) but not switched: their switched callers above verify their results.
// Stricter than the JS (the crate docs): see llamacpp-autoconfig-differential.test.cjs's strict
// table; those inputs are a port refusal, handled as above.

const defaultLoader = () => require('./dav-parse-wasm.cjs');

/** The port could not confirm an estimate and the JS one is not the conservative answer. */
class AutoconfigImplError extends Error {
  constructor(what) {
    super(`the memory estimate (${what}) could not be confirmed by the Rust sizing port, and the JS estimate is not the larger one.`);
    this.name = 'AutoconfigImplError';
    this.code = 'autoconfig_impl';
    this.status = 503;
  }
}
const IMPL_SUGGEST_ERROR = 'No settings suggested: the Rust sizing port did not confirm this suggestion and the JS one is not the smaller. Size the context manually and load-test it.';

const warnedPort = new Set();
function portWarn(fn, event, reason) {
  const key = `${fn}:${event}:${reason}`;
  if (warnedPort.has(key)) return;
  warnedPort.add(key);
  console.warn(`[llamacpp-autoconfig] ${fn}.${event} (${reason})`);
}

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (typeof v === 'number' ? v : NaN);
const SIZED_KNOBS = new Set(['ctx-size', 'parallel', 'n-gpu-layers', 'cache-ram', 'ubatch-size', 'batch-size', 'image-max-tokens']);
const EQUAL_KNOBS = new Set(['flash-attn', 'cache-type-k', 'cache-type-v', 'spec-type']);

/** True when the JS suggestion is no larger than the port's (or suggests nothing). */
function suggestionIsConservative(js, port) {
  if (!isObj(js)) return false;
  if (typeof js.error === 'string' && js.values === undefined) return true;
  if (!isObj(js.values) || !isObj(port) || !isObj(port.values)) return false;
  const keys = Object.keys(js.values);
  if (keys.length !== Object.keys(port.values).length) return false;
  return keys.every((k) => {
    if (!Object.prototype.hasOwnProperty.call(port.values, k)) return false;
    const a = js.values[k], b = port.values[k];
    if (EQUAL_KNOBS.has(k)) return a === b;
    if (!SIZED_KNOBS.has(k) || typeof a !== 'string' || typeof b !== 'string') return false;
    return Number(a) <= Number(b);
  });
}

/** True when the JS footprint refuses at least whatever the port's would. */
function footprintIsConservative(js, port) {
  if (!isObj(js)) return false;
  if (js.cacheRamUnbounded === true) return true;
  if (Number.isNaN(js.totalGib)) return true; // NaN <= budget is false: the load is refused
  if (!isObj(port) || port.cacheRamUnbounded !== false) return false;
  if (typeof js.totalGib !== 'number' || typeof port.totalGib !== 'number') return false;
  if (js.sizeable === true && port.sizeable !== true) return false;
  return js.totalGib >= port.totalGib;
}

/** True when every JS figure of the Will-it-fit inputs is at least the port's. */
function inputsAreConservative(js, port) {
  if (!isObj(js) || !isObj(port) || !Array.isArray(js.rows) || !Array.isArray(port.rows)) return false;
  if (js.rows.length !== port.rows.length || js.reserveGib !== port.reserveGib || js.safety !== port.safety) return false;
  // noevia#1134: the facts the panel shows beside the figures must be the same, not just no smaller.
  if (js.moe !== port.moe || js.chat !== port.chat || js.nativeCtx !== port.nativeCtx) return false;
  if (!isObj(js.current) || !isObj(port.current) || js.current.ctx !== port.current.ctx || js.current.kv !== port.current.kv) return false;
  const atLeast = (a, b) => typeof a === 'number' && typeof b === 'number' && a >= b;
  if (!atLeast(js.modelGib, port.modelGib) || !atLeast(js.pinnedGib, port.pinnedGib)) return false;
  if (js.cacheRamGib !== null && !atLeast(js.cacheRamGib, port.cacheRamGib)) return false;
  return js.rows.every((r, i) => isObj(r) && isObj(port.rows[i]) && r.ctx === port.rows[i].ctx && atLeast(r.kvQ8Gib, port.rows[i].kvQ8Gib));
}

// `undefined` when the port agrees or the JS answer is the conservative one (return the JS answer);
// otherwise the reason it is not.
function disagreement(fn, op, args, js, conservative, wasmLoader) {
  let port = null, refused = null;
  try {
    port = wasmLoader().llamacppAutoconfig(op, args);
  } catch (err) {
    refused = String(err?.reason || 'unexpected').slice(0, 40);
  }
  let jsText;
  try { jsText = JSON.stringify(js); } catch { jsText = undefined; }
  if (port && typeof jsText === 'string' && port.text === jsText) return undefined;
  let ok = false;
  try { ok = !!conservative(js, port ? port.reply : null); } catch { ok = false; }
  portWarn(fn, refused ? 'wasm_refused' : 'impl_mismatch', `${refused || 'answer'}; ${ok ? 'the JS answer is the conservative one' : 'refused'}`);
  return ok ? undefined : (refused ? 'impl_refused' : 'impl_mismatch');
}

/**
 * suggestJs, confirmed by the Rust port (see above). Option: `wasmLoader`.
 */
function suggest(args, { wasmLoader = defaultLoader } = {}) {
  const js = suggestJs(args);
  const why = disagreement('suggest', 1, args, js, suggestionIsConservative, wasmLoader);
  return why ? { error: IMPL_SUGGEST_ERROR, code: 'autoconfig_impl', unverified: why } : js;
}

/** estimateInputsJs, confirmed as suggest is; throws an AutoconfigImplError when it cannot be. */
function estimateInputs(args, { wasmLoader = defaultLoader } = {}) {
  const js = estimateInputsJs(args);
  if (disagreement('estimateInputs', 2, args, js, inputsAreConservative, wasmLoader)) throw new AutoconfigImplError('Will it fit?');
  return js;
}

/** estimateFootprintJs, confirmed as suggest is; throws an AutoconfigImplError when it cannot be. */
function estimateFootprint(args, { wasmLoader = defaultLoader } = {}) {
  const js = estimateFootprintJs(args);
  if (disagreement('estimateFootprint', 3, args, js, footprintIsConservative, wasmLoader)) throw new AutoconfigImplError('load footprint');
  return js;
}

module.exports = { isPromptCacheFree, suggest, suggestJs, estimateInputs, estimateInputsJs, estimateFootprint, estimateFootprintJs, AutoconfigImplError,
  suggestionIsConservative, footprintIsConservative, inputsAreConservative, cacheRamMibOf, kvCacheBytes, parseMemoryLimit, CTX_CANDIDATES, KV_TYPE_BYTES, LLAMA_CACHE_RAM_DEFAULT_MIB };
