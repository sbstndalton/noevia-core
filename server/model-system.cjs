'use strict';
// Some router entries are internal system routing models, not chat models a person configures
// or tunes — Laya (the multilingual detector the Auto route consults) is the only one today.
// #1179: the marker is an explicit `role = laya` key in the models.ini section. The name/path rule
// below is only a deprecated fallback for a section that has no role key; it is logged once per id.
const LAYA_PREFIX = /^laya(?:[_.-]|$)/i;
const LAYA_ROLE = 'laya';

function isLayaToken(value) {
  return LAYA_PREFIX.test(String(value || '').trim());
}

// Section name -> lower-cased role, as models.ini last read it (rememberSectionRoles). Routers name
// a preset by its section, so a router id is the section name.
const sectionRoles = new Map();
const nameRuleLogged = new Set();

/** The explicit `role` of each models.ini section in `text` (same section headers as the preset parser). */
function sectionRolesOf(text) {
  const roles = new Map();
  let current = null;
  for (const line of String(text || '').split('\n')) {
    const header = /^\s*\[([^\]\r\n]+)\]\s*(?:[;#].*)?$/.exec(line);
    if (header) { current = header[1]; continue; }
    if (current === null || current === '*') continue;
    const match = /^\s*role\s*=\s*(.*?)\s*$/i.exec(line);
    if (match && !roles.has(current)) roles.set(current, match[1].trim().toLowerCase());
  }
  return roles;
}

/** Replaces what the explicit roles of the models.ini just read say (called by the preset store). */
function rememberSectionRoles(text) {
  sectionRoles.clear();
  for (const [name, role] of sectionRolesOf(text)) if (role) sectionRoles.set(name, role);
}

/** The value that follows a "--model"/"-m" flag in a router process's argv, if any. */
function modelPathFromArgs(args) {
  if (!Array.isArray(args)) return '';
  const i = args.findIndex(a => a === '--model' || a === '-m');
  return i >= 0 && typeof args[i + 1] === 'string' ? args[i + 1] : '';
}

// The deprecated fallback, for a section with no role key: logged once per name.
function fallbackLaya(token, where) {
  if (!nameRuleLogged.has(token)) {
    nameRuleLogged.add(token);
    console.warn(`[model-system] ${token} is treated as Laya by the deprecated ${where} rule; add "role = laya" to its models.ini section (#1179)`);
  }
  return true;
}

/**
 * True when `id` (a router/preset model id) or `modelPath` (a "--model" argument or preset file
 * path) identifies Laya, noevia's internal multilingual routing model. Laya is never offered for
 * tuning or manual configuration: it fits the system rather than a person tuning it. An explicit
 * `role = laya` in the id's models.ini section decides; only without one does the name/path rule apply.
 */
function isSystemModel(id, modelPath) {
  const key = id === undefined || id === null ? '' : String(id).trim();
  if (key && sectionRoles.has(key)) return sectionRoles.get(key) === LAYA_ROLE;
  if (isLayaToken(key)) return fallbackLaya(key, 'name');
  const path = String(modelPath || '');
  if (!path) return false;
  const segments = path.split(/[\\/]/).filter(Boolean);
  return segments.some(seg => {
    const token = seg.replace(/\.gguf$/i, '');
    return isLayaToken(token) && fallbackLaya(token, 'path');
  });
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

const SYSTEM_MODEL_LOAD_REASON = 'System routing model runs in its own service — it is not loaded or unloaded here';
const SIDECAR_MODEL_LOAD_REASON = 'A running sidecar (embedding or reranking) manages this model — it is not loaded or unloaded here';
const MISSING_MODEL_FILE_REASON = 'This preset points at a model file that is not in the models folder — it cannot be loaded';

module.exports = {
  SYSTEM_MODEL_LOAD_REASON, SIDECAR_MODEL_LOAD_REASON, MISSING_MODEL_FILE_REASON,
  isSystemModel, modelPathFromArgs, SYSTEM_MODEL_REASON, SYSTEM_MODEL_DELETE_REASON, sectionRolesOf, rememberSectionRoles, LAYA_ROLE,
  sidecarModelNames, isSidecarModel, SIDECAR_MODEL_DELETE_REASON,
};
