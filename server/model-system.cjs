'use strict';
// Some router entries are internal system routing models, not chat models a person configures
// or tunes — Laya (the multilingual detector the Auto route consults) is the only one today.
// #1179/#1596: the marker is an entry in noevia's own roles file beside models.ini
// (models.roles.json: {"<section>": "system-routing"}). It is NOT a key in models.ini: llama-server reads that
// file too and its preset loader throws on an option it does not know. The name/path rule below is only
// a deprecated fallback for a section that has no role; it is logged once per id.
const fs = require('node:fs');
const path = require('node:path');
const LAYA_PREFIX = /^laya(?:[_.-]|$)/i;
// noevia#2093 phase 1: a roles file may name the role ("system-routing") or still carry the legacy role
// key. Readers accept both; the legacy key is accepted until phase 3 of that migration. Writers, the
// oracle generators and the files on disk do not change in phase 1.
const SYSTEM_ROUTING_ROLE = 'system-routing';
const LEGACY_SYSTEM_ROUTING_ROLES = Object.freeze(['laya']);
/** @deprecated the legacy role key; use isSystemRoutingRole (kept so an importer of the old name still works). */
const LAYA_ROLE = LEGACY_SYSTEM_ROUTING_ROLES[0];
const ROLES_FILENAME = 'models.roles.json';

/** True when `role` (a roles-file value, as sectionRolesOf returns it: trimmed and lower-cased) is the system routing role, spelled by name or by the legacy key. */
function isSystemRoutingRole(role) {
  return role === SYSTEM_ROUTING_ROLE || LEGACY_SYSTEM_ROUTING_ROLES.includes(role);
}

function isLayaToken(value) {
  return LAYA_PREFIX.test(String(value || '').trim());
}

// Section name -> lower-cased role, as the roles file last read it. Routers name a preset by its
// section, so a router id is the section name.
const sectionRoles = new Map();
const nameRuleLogged = new Set();
let rolesFile = null;      // absolute path of the roles file, once a preset store has named models.ini
let rolesStamp = null;     // "mtimeMs:size:ino" of the file as last read ('' = missing)
let rolesBadLogged = null;

/** The roles file that belongs to a models.ini path. */
function rolesFileFor(presetFile) {
  return path.join(path.dirname(presetFile), ROLES_FILENAME);
}

/** The explicit role of each section in the roles-file `text` (a JSON object of id -> role). */
function sectionRolesOf(text) {
  const roles = new Map();
  let data;
  try { data = JSON.parse(String(text || '')); } catch { return roles; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return roles;
  for (const [name, role] of Object.entries(data)) {
    if (typeof role === 'string' && role.trim() && name !== '*') roles.set(name, role.trim().toLowerCase());
  }
  return roles;
}

/** Replaces what the explicit roles say (the roles-file text; '' clears them). */
function rememberSectionRoles(text) {
  sectionRoles.clear();
  for (const [name, role] of sectionRolesOf(text)) sectionRoles.set(name, role);
}

/** Names the models.ini whose sibling roles file isSystemModel follows (called when a preset store is made). */
function useRolesBeside(presetFile) {
  const next = presetFile ? rolesFileFor(presetFile) : null;
  if (next === rolesFile) return;
  rolesFile = next;
  rolesStamp = null;
  rememberSectionRoles('');
}

/** Re-reads the roles file when it changed on disk (a missing or unusable file means no explicit roles). */
function refreshRoles() {
  if (!rolesFile) return;
  let stamp = '', text = '';
  try {
    const st = fs.statSync(rolesFile);
    stamp = `${st.mtimeMs}:${st.size}:${st.ino}`;
    if (stamp === rolesStamp) return;
    text = fs.readFileSync(rolesFile, 'utf8');
  } catch (err) {
    if (err?.code !== 'ENOENT' && rolesBadLogged !== rolesFile) {
      rolesBadLogged = rolesFile;
      console.warn(`[model-system] ${rolesFile} is ignored: ${err?.code || 'unreadable'} (#1596)`);
    }
    stamp = '';
  }
  rolesStamp = stamp;
  rememberSectionRoles(text);
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
    console.warn(`[model-system] ${token} is treated as Laya by the deprecated ${where} rule; mark it in ${ROLES_FILENAME} beside models.ini ({"${token}": "laya"}), not in models.ini, which llama.cpp also reads (#1179, #1596)`);
  }
  return true;
}

/**
 * True when `id` (a router/preset model id) or `modelPath` (a "--model" argument or preset file
 * path) identifies Laya, noevia's internal multilingual routing model. Laya is never offered for
 * tuning or manual configuration: it fits the system rather than a person tuning it. An explicit
 * system routing role for the id in models.roles.json ("system-routing", or the legacy role key
 * until phase 3 of noevia#2093) decides; only without one does the name/path rule apply.
 */
function isSystemModel(id, modelPath) {
  const key = id === undefined || id === null ? '' : String(id).trim();
  refreshRoles();
  if (key && sectionRoles.has(key)) return isSystemRoutingRole(sectionRoles.get(key));
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
// #1636: also the model a re-index is building (EMBEDDING_NEXT_MODEL) and, once the process's
// embedding configuration (embedding-config.cjs) is installed, its active, next and previous
// (rollback) models: each of them still has a server and stored vectors that depend on it.
// #1660 review / #1668: while the model manager does not manage the embed container (older image,
// or no EMBED_CONTAINER), the env names stay protected even after the saved embedding configuration
// switched away: that container is started from compose with a fixed `-m <file>`, so deleting the
// file crash-loops it on its next restart (#336). Once the model manager manages it
// (embedding-service.cjs), the env name is a seed only and protection follows what the service is
// set to serve, may still hold, or reports loaded. If that answer is stale (the model manager did
// not answer lately) the env names and the saved configuration are protected as well: fail closed.
function sidecarModelNames(env = process.env) {
  const names = new Set();
  const service = require('./embedding-service.cjs').current();
  const status = service?.managed() ? service.status() : null;
  const envNames = [String(env.EMBEDDING_MODEL || env.EMBED_MODEL || '').trim(), String(env.EMBEDDING_NEXT_MODEL || '').trim()];
  const configNames = require('./embedding-config.cjs').current()?.modelNames() || [];
  const embedNames = status && !status.stale
    ? [...service.protectedNames(), ...configNamesServedElsewhere(configNames, service)]
    : [...envNames, ...configNames, ...(status ? service.protectedNames() : [])];
  for (const embed of embedNames) if (embed && embed.toLowerCase() !== 'default') names.add(embed);
  const rerankOn = /^(1|true|on)$/i.test(String(env.NOEVIA_FEATURE_RAG_RERANK || ''));
  const rerank = rerankOn ? String(env.RERANK_MODEL || '').trim() : '';
  if (rerank) names.add(rerank);
  return names;
}

// A configured target this service does not serve (the inference engine when baseUrl is null, or
// another machine, #1638) keeps the pre-#1668 rule: its name stays protected.
function configNamesServedElsewhere(configNames, service) {
  const config = require('./embedding-config.cjs').current();
  const targets = config ? [config.active(), config.next(), config.previous()].filter(Boolean) : [];
  return targets.filter((t) => !service.isAt(t.baseUrl) && configNames.includes(t.model)).map((t) => t.model);
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
  isSystemModel, modelPathFromArgs, SYSTEM_MODEL_REASON, SYSTEM_MODEL_DELETE_REASON, sectionRolesOf, rememberSectionRoles, useRolesBeside, refreshRoles, rolesFileFor, ROLES_FILENAME, LAYA_ROLE,
  SYSTEM_ROUTING_ROLE, LEGACY_SYSTEM_ROUTING_ROLES, isSystemRoutingRole,
  sidecarModelNames, isSidecarModel, SIDECAR_MODEL_DELETE_REASON,
};
