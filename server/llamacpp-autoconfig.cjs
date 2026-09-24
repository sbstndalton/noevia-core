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
function suggest({ meta, modelBytes, mmprojBytes = 0, budgetGib, current = {}, cacheRamMaxMib = 1024 }) {
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
  const rows = candidates.map(ctx => {
    const kvGib = (kvCacheBytes(m, ctx) + draftKvBytes(m, ctx)) / GIB;
    const totalGib = (modelGib + kvGib + pinnedGib + RESERVE_GIB) * SAFETY;
    return { ctx, modelGib: round2(modelGib), kvGib: round2(kvGib), extraGib: round2(pinnedGib + RESERVE_GIB), totalGib: round2(totalGib), fits: totalGib <= budgetGib };
  });
  const fitting = rows.filter(r => r.fits);
  if (!fitting.length) return { error: `This model needs about ${round2((modelGib + pinnedGib + RESERVE_GIB) * SAFETY)} GiB before any context, more than the ${budgetGib} GiB budget. Use a smaller quantization.`, rows, budgetGib };
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

function parseMemoryLimit(value) {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([kmgt]?)i?b?\s*$/i.exec(String(value || ''));
  if (!match) return null;
  const scale = { '': 1 / GIB, k: 1 / (1024 ** 2), m: 1 / 1024, g: 1, t: 1024 }[match[2].toLowerCase()];
  return Number(match[1]) * scale;
}

module.exports = { suggest, kvCacheBytes, parseMemoryLimit, CTX_CANDIDATES };
