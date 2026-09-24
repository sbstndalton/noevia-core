'use strict';
// Task-aware sampling presets (issue #194): temperature/top_p/top_k/repeat_penalty chosen
// automatically from the chat's routed task class, applied only when the user has not set
// explicit sampling values for the chat/model. Kept separate from KV-cache/memory tuning.
//
// Presets are versioned so a future change to the numbers is visible in reply details and in
// tests, not a silent behavior change. Values are chosen consistent with
// docs/research-known-good-settings.md (temperature 0 for deterministic/quality probes; these
// presets are for ordinary chat, not those probes).

const PRESETS_VERSION = 1;

// `general` intentionally carries no parameters: "current defaults" means the server sends
// nothing and the engine/model's own defaults apply, exactly as chat behaved before this
// feature existed.
const PRESETS = Object.freeze({
  general: Object.freeze({}),
  coding: Object.freeze({ temperature: 0.2, top_p: 0.9, repeat_penalty: 1.05 }),
  creative: Object.freeze({ temperature: 0.9, top_p: 0.95 }),
  reasoning: Object.freeze({ temperature: 0.5 }),
});

const SAMPLING_KEYS = Object.freeze(['temperature', 'top_p', 'top_k', 'repeat_penalty']);

// A cheap heuristic for creative-writing requests. The auto-router already classifies
// fast/smart/code; there is no "creative" router class, so this narrow, deterministic check
// runs only to promote an otherwise fast/smart message to the creative preset. It never
// overrides an explicit code classification.
const CREATIVE_RE = /\b(write|compose|draft)\s+(a|an|some)?\s*(short\s+)?(story|poem|poetry|song|lyrics|screenplay|scene|fiction|novel|haiku|sonnet)\b|\bcreative\s+writing\b|\bbrainstorm\s+(names|titles|taglines)\b/i;

/**
 * Choose a preset id from the router's role (fast/smart/code) and a cheap heuristic on the
 * message. Reuses the existing auto-router/system-one-router signal per issue #194; only when
 * that signal did not fire in a way that identifies creative writing does the heuristic apply.
 * @param {{ routedRole?: string|null, message?: string }} args
 */
function classifyTaskForSampling({ routedRole, message } = {}) {
  const text = typeof message === 'string' ? message : '';
  if (routedRole !== 'code' && CREATIVE_RE.test(text)) return 'creative';
  if (routedRole === 'code') return 'coding';
  if (routedRole === 'smart') return 'reasoning';
  return 'general';
}

/** True if the value is a finite, in-range number for that sampling key. */
function validSamplingValue(key, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (key === 'temperature') return value >= 0 && value <= 2;
  if (key === 'top_p') return value > 0 && value <= 1;
  if (key === 'top_k') return Number.isInteger(value) && value >= 0;
  if (key === 'repeat_penalty') return value >= 0 && value <= 3;
  return false;
}

/** Strips an arbitrary object down to the recognized, validated sampling keys. */
function sanitizeExplicitSampling(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const out = {};
  for (const key of SAMPLING_KEYS) if (validSamplingValue(key, raw[key])) out[key] = raw[key];
  return Object.keys(out).length ? out : undefined;
}

/**
 * Selects the sampling parameters for one chat request.
 * Precedence: explicit values (per chat/model/project) always win, key by key; auto preset
 * fills in only the keys the explicit override did not set, and only when autoEnabled; if
 * autoEnabled is false, nothing beyond the explicit override is sent — the documented fallback
 * of "no tuning happened" rather than silently guessing.
 * @param {{ routedRole?: string|null, message?: string, explicit?: object, autoEnabled?: boolean }} args
 * @returns {{ params: object, presetId: string|null, source: 'explicit'|'auto'|'none', version: number }}
 */
function selectSamplingParams({ routedRole = null, message = '', explicit = null, autoEnabled = true } = {}) {
  const explicitParams = sanitizeExplicitSampling(explicit) || {};
  const hasExplicit = Object.keys(explicitParams).length > 0;
  if (!autoEnabled) {
    return { params: { ...explicitParams }, presetId: null, source: hasExplicit ? 'explicit' : 'none', version: PRESETS_VERSION };
  }
  const presetId = classifyTaskForSampling({ routedRole, message });
  const preset = PRESETS[presetId] || PRESETS.general;
  const params = { ...preset, ...explicitParams };
  const source = Object.keys(params).length === 0 ? 'none' : hasExplicit && Object.keys(preset).every(k => k in explicitParams) ? 'explicit' : 'auto';
  return { params, presetId, source, version: PRESETS_VERSION };
}

module.exports = { PRESETS, PRESETS_VERSION, SAMPLING_KEYS, classifyTaskForSampling, sanitizeExplicitSampling, validSamplingValue, selectSamplingParams };
