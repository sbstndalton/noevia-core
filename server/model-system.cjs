'use strict';
// Some router entries are internal system routing models, not chat models a person configures
// or tunes — Laya (the multilingual detector the Auto route consults) is the only one today.
// Match is case-insensitive and covers both the preset/router id (e.g. "laya_multilingual_f16")
// and any "--model"/"-m" path segment, so a differently-cased id or a renamed folder still counts.
const LAYA_PREFIX = /^laya(?:[_.-]|$)/i;

function isLayaToken(value) {
  return LAYA_PREFIX.test(String(value || '').trim());
}

/** The value that follows a "--model"/"-m" flag in a router process's argv, if any. */
function modelPathFromArgs(args) {
  if (!Array.isArray(args)) return '';
  const i = args.findIndex(a => a === '--model' || a === '-m');
  return i >= 0 && typeof args[i + 1] === 'string' ? args[i + 1] : '';
}

/**
 * True when `id` (a router/preset model id) or `modelPath` (a "--model" argument or preset file
 * path) identifies Laya, noevia's internal multilingual routing model. Laya is never offered for
 * tuning or manual configuration: it fits the system rather than a person tuning it.
 */
function isSystemModel(id, modelPath) {
  if (isLayaToken(id)) return true;
  const path = String(modelPath || '');
  if (!path) return false;
  const segments = path.split(/[\\/]/).filter(Boolean);
  return segments.some(seg => isLayaToken(seg.replace(/\.gguf$/i, '')));
}

const SYSTEM_MODEL_REASON = 'System routing model — not tuned';
const SYSTEM_MODEL_DELETE_REASON = 'System routing model — not deleted';

module.exports = { isSystemModel, modelPathFromArgs, SYSTEM_MODEL_REASON, SYSTEM_MODEL_DELETE_REASON };
