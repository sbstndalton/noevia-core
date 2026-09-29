'use strict';
// Per-model sampling recommendation (#308) and the per-family facts the tuner shares (#328).
//
// Precedence, first tier with any usable value wins as a whole (never mixed key by key, so the
// source shown to the operator describes every number applied):
//   1. model-card: the source repo's generation_config.json, imported by model-evidence-import (#508)
//   2. family:     the curated table below, matched on the model name
//   3. preset:     the task-aware preset for ordinary chat (#194/#246); "general" is empty, so the
//                  engine's own defaults stay in force
// Everything here is deterministic. No model is asked to choose a number.
const { PRESETS, PRESETS_VERSION, validSamplingValue } = require('./sampling-presets.cjs');

const FAMILY_TABLE_VERSION = 1;
// Order matters: a distilled reasoning model is named after its base architecture, so the
// specific patterns come before the generic ones. Values follow each family's published card.
const FAMILIES = Object.freeze([
  { id: 'gpt-oss', label: 'GPT-OSS', match: /(?:^|[^a-z0-9])gpt[-_. ]?oss(?:\d|[^a-z0-9]|$)/i,
    values: { temperature: 1.0, top_p: 1.0, top_k: 0 },
    // Harmony chat format: an analysis channel precedes the final answer, so quality probes need
    // a larger finite budget and an explicit low reasoning effort.
    quirks: { harmony: true, reasoningEffort: 'low', qualityBudget: 512 } },
  { id: 'deepseek-r1', label: 'DeepSeek R1 distill', match: /deepseek[-_. ]?r1/i,
    values: { temperature: 0.6, top_p: 0.95 }, quirks: {} },
  // Qwen3.5 must precede Qwen3, whose pattern also matches it. Card (thinking mode, general tasks):
  // https://huggingface.co/Qwen/Qwen3.5-9B and https://huggingface.co/Qwen/Qwen3.5-4B list
  // temperature 1.0, top_p 0.95, top_k 20, min_p 0.0 (plus a presence penalty this runtime
  // setting set does not carry). It differs from Qwen3's 0.6, so it has its own entry.
  { id: 'qwen3.5', label: 'Qwen3.5', match: /qwen[-_. ]?3[-_. ]?5/i,
    values: { temperature: 1.0, top_p: 0.95, top_k: 20, min_p: 0 }, quirks: {}, note: 'thinking-mode values' },
  { id: 'qwen3', label: 'Qwen3', match: /qwen[-_. ]?3/i,
    // The card splits thinking from non-thinking; these are the thinking-mode values.
    values: { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0 }, quirks: {}, note: 'thinking-mode values' },
  { id: 'llama-3', label: 'Llama 3', match: /llama[-_. ]?3/i,
    values: { temperature: 0.6, top_p: 0.9 }, quirks: {} },
  // Gemma 4 card (verified 2026-09-28): https://huggingface.co/google/gemma-4-E2B-it and
  // https://huggingface.co/google/gemma-4-E4B-it recommend temperature 1.0, top_p 0.95, top_k 64,
  // and their generation_config.json agrees. The card gives no min_p.
  { id: 'gemma-4', label: 'Gemma 4', match: /gemma[-_. ]?4/i,
    values: { temperature: 1.0, top_p: 0.95, top_k: 64 }, quirks: {} },
  { id: 'gemma-3', label: 'Gemma 3', match: /gemma[-_. ]?3/i,
    values: { temperature: 1.0, top_p: 0.95, top_k: 64, min_p: 0 }, quirks: {} },
  { id: 'devstral', label: 'Devstral / Mistral', match: /devstral|mistral/i,
    values: { temperature: 0.2 }, quirks: {} },
  { id: 'phi-4', label: 'Phi-4', match: /phi[-_. ]?4/i,
    values: { temperature: 0.8, top_p: 0.95, top_k: 50 }, quirks: {} },
]);
const NO_QUIRKS = Object.freeze({});
const familyOf = model => FAMILIES.find(f => f.match.test(String(model || ''))) || null;
const hasHarmonyReasoning = model => familyOf(model)?.quirks.harmony === true;
const quirksOf = model => familyOf(model)?.quirks || NO_QUIRKS;

const KEYS = ['temperature', 'top_p', 'top_k', 'min_p', 'repeat_penalty'];
const validMinP = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
// top_p of 1 and top_k of 0 mean "off" and are valid; the shared validator already accepts them.
const valid = (key, v) => key === 'min_p' ? validMinP(v) : validSamplingValue(key, v);
function clean(values) {
  const out = {};
  for (const key of KEYS) if (values && valid(key, values[key])) out[key] = values[key];
  return out;
}
// llama-server argument names, which are also the models.ini keys.
const INI_KEYS = Object.freeze({ temperature: 'temp', top_p: 'top-p', top_k: 'top-k', min_p: 'min-p', repeat_penalty: 'repeat-penalty' });
const INI_KEY_LIST = Object.freeze(Object.values(INI_KEYS));
const num = n => String(Math.round(n * 1000) / 1000);
function toIniOptions(values) {
  const out = {};
  for (const key of KEYS) if (valid(key, values?.[key])) out[INI_KEYS[key]] = num(values[key]);
  return out;
}

/**
 * @param {{ model: string, sourceValues?: object|null, sourceProvenance?: object|null, presetId?: string }} args
 * @returns {{ tier: 'model-card'|'family'|'preset', source: string, values: object, familyId: string|null,
 *   quirks: object, note: string|null, provenance: object|null, versions: object }}
 */
function resolveSamplingRecommendation({ model, sourceValues = null, sourceProvenance = null, presetId = 'general' } = {}) {
  const family = familyOf(model);
  const base = { familyId: family?.id || null, quirks: family?.quirks || NO_QUIRKS,
    versions: { familyTable: FAMILY_TABLE_VERSION, presets: PRESETS_VERSION } };
  const card = clean(sourceValues);
  if (Object.keys(card).length) return { ...base, tier: 'model-card', source: 'generation_config.json', values: card, note: null, provenance: sourceProvenance };
  if (family) {
    const values = clean(family.values);
    if (Object.keys(values).length) return { ...base, tier: 'family', source: family.label + ' family table', values, note: family.note || null, provenance: null };
  }
  const id = Object.hasOwn(PRESETS, presetId) ? presetId : 'general';
  return { ...base, tier: 'preset', source: 'Task preset: ' + id, values: clean(PRESETS[id]), note: null, provenance: null };
}

module.exports = { FAMILIES, FAMILY_TABLE_VERSION, INI_KEYS, INI_KEY_LIST, familyOf, hasHarmonyReasoning, quirksOf,
  resolveSamplingRecommendation, toIniOptions };
