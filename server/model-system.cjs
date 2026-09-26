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

// Model names a live sidecar depends on right now: the RAG embedding model (EMBEDDING_MODEL, or
// EMBED_MODEL — same precedence rag.cjs's init() uses) and, only when the RAG reranker feature is
// actually on, RERANK_MODEL. Mirrors llamacpp-manager.cjs's keepAlongside() (out of scope to edit
// here), which uses the same two names to decide what never gets evicted from a single-slot
// engine. Deleting one of these while its sidecar is still pointed at it crash-loops that sidecar
// (#336) — there is no fallback name to load instead, so the guard is name-based, not label-based:
// an unused, merely embeddings-labelled install is not protected, only the one actually wired up.
// `env` is read at call time (same convention as the rest of the model routes), defaulting to
// process.env so callers outside a request (e.g. the installed-list mapper) need not pass it.
function sidecarModelNames(env = process.env) {
  const names = new Set();
  const embed = String(env.EMBEDDING_MODEL || env.EMBED_MODEL || '').trim();
  if (embed && embed.toLowerCase() !== 'default') names.add(embed);
  const rerankOn = /^(1|true|on)$/i.test(String(env.NOEVIA_FEATURE_RAG_RERANK || ''));
  const rerank = rerankOn ? String(env.RERANK_MODEL || '').trim() : '';
  if (rerank) names.add(rerank);
  return names;
}

/** True when `name` is the configured embedding model or (feature-gated) reranker. */
function isSidecarModel(name, env = process.env) {
  const n = String(name || '').trim();
  return !!n && sidecarModelNames(env).has(n);
}

const SIDECAR_MODEL_DELETE_REASON = 'A running sidecar (embedding or reranking) depends on this model — not deleted';

module.exports = {
  isSystemModel, modelPathFromArgs, SYSTEM_MODEL_REASON, SYSTEM_MODEL_DELETE_REASON,
  sidecarModelNames, isSidecarModel, SIDECAR_MODEL_DELETE_REASON,
};
