'use strict';
// #1636 / #1638: the one embedding configuration of this web process. Every embedding call
// (project RAG, the tool and skill routers, chat framing) reads its endpoint, model and profile
// from here, never from the environment directly.
//
//   active    what search and indexing use now
//   next      what a re-index is building towards (null when none is under way)
//   previous  what was active before the last switch, kept for rollback until `finish`
//
// A target is { baseUrl, model, profile }. baseUrl null means "the inference engine"
// (INFERENCE_BASE_URL, with its credentials); a URL means a dedicated embeddings server, which
// never receives the engine credentials. The identity of stored vectors is (profile, model): the
// endpoint is where the model runs, not what it is, so moving a model to another machine keeps
// its vectors (embedding-migration.cjs checks the new endpoint gives the same vectors first).
//
// The environment only SEEDS this object (EMBEDDING_BASE_URL, EMBEDDING_MODEL / EMBED_MODEL,
// EMBEDDING_PROFILE, and EMBEDDING_NEXT_BASE_URL / EMBEDDING_NEXT_MODEL / EMBEDDING_NEXT_PROFILE
// to start a re-index). Once a change is made at runtime (embedding-migration.cjs, the one path
// that changes the model or the endpoint) it is saved to `stateFile` and that file wins over the
// environment on the next start. Deleting the file returns to the environment's values.

const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_PROFILE, profileNamed, profileNames } = require('./embedding-profile.cjs');

const MODEL_RE = /^[^\s\u0000-\u001f]{1,200}$/;

function invalid(message) { return Object.assign(Error(message), { status: 400, code: 'invalidTarget' }); }

function normalizeBaseUrl(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  let url;
  try { url = new URL(text); } catch { throw invalid('The embeddings address must be an http(s) URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw invalid('The embeddings address must be a plain http(s) URL, with no credentials, query or fragment.');
  }
  return text.replace(/\/+$/, '');
}

/** A validated copy of `t`, or throws (status 400). */
function normalizeTarget(t) {
  if (!t || typeof t !== 'object') throw invalid('An embedding target needs a model.');
  const model = String(t.model ?? '').trim();
  if (!MODEL_RE.test(model)) throw invalid('An embedding target needs a model name (no spaces, at most 200 characters).');
  const profile = String(t.profile ?? DEFAULT_PROFILE).trim() || DEFAULT_PROFILE;
  if (!profileNamed(profile)) throw invalid(`Unknown embedding profile "${profile}" (known: ${profileNames().join(', ')}).`);
  return { baseUrl: normalizeBaseUrl(t.baseUrl), model, profile };
}

const identityOf = (t) => (t ? `${t.profile}\u0000${t.model}` : '');
const sameIdentity = (a, b) => !!a && !!b && identityOf(a) === identityOf(b);
const sameTarget = (a, b) => sameIdentity(a, b) && (a.baseUrl || null) === (b.baseUrl || null);

/** The targets the environment describes. An unknown profile is kept as given, so it fails closed later. */
function seedFromEnv(env = process.env, fallbackModel = 'default') {
  const pick = (...keys) => keys.map((k) => String(env[k] ?? '').trim()).find(Boolean) || '';
  const active = {
    baseUrl: pick('EMBEDDING_BASE_URL') || null,
    model: pick('EMBEDDING_MODEL', 'EMBED_MODEL') || fallbackModel || 'default',
    profile: pick('EMBEDDING_PROFILE') || DEFAULT_PROFILE,
  };
  const nextModel = pick('EMBEDDING_NEXT_MODEL');
  const next = nextModel ? {
    baseUrl: pick('EMBEDDING_NEXT_BASE_URL') || null,
    model: nextModel,
    profile: pick('EMBEDDING_NEXT_PROFILE') || DEFAULT_PROFILE,
  } : null;
  return { active, next: next && !sameTarget(next, active) ? next : null, previous: null };
}

function readState(stateFile) {
  if (!stateFile) return null;
  let raw;
  try { raw = fs.readFileSync(stateFile, 'utf8'); } catch { return null; }
  try {
    const s = JSON.parse(raw);
    if (s?.version !== 1) throw Error('unknown version');
    return {
      active: normalizeTarget(s.active),
      next: s.next ? normalizeTarget(s.next) : null,
      previous: s.previous ? normalizeTarget(s.previous) : null,
    };
  } catch (err) {
    // A damaged file must not silently put the environment's (possibly older) model back in charge
    // of indexes that were already switched: refuse to start the embedding side instead.
    throw Object.assign(Error(`The saved embedding configuration ${stateFile} cannot be read (${err.message}). Fix or delete it.`), { code: 'badState' });
  }
}

/**
 * @param {object} [o]
 * @param {object} [o.env]            seed values (process.env)
 * @param {string|null} [o.stateFile] where runtime changes are saved; null keeps them in memory
 * @param {string} [o.fallbackModel]  model when the environment names none
 */
function createEmbeddingConfig({ env = process.env, stateFile = null, fallbackModel = 'default' } = {}) {
  const saved = readState(stateFile);
  let state = saved || seedFromEnv(env, fallbackModel);
  const source = saved ? 'saved' : 'environment';
  let version = 0;
  const listeners = new Set();
  const copy = (t) => (t ? { ...t } : null);

  function persist() {
    if (!stateFile) return;
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const tmp = `${stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, ...state }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, stateFile);
  }
  function change(next) {
    const before = state;
    state = next;
    try { persist(); } catch (err) { state = before; throw err; }
    version += 1;
    for (const fn of listeners) { try { fn(get()); } catch { /* a listener never blocks a change */ } }
    return get();
  }
  function get() {
    return { active: copy(state.active), next: copy(state.next), previous: copy(state.previous), source: version || saved ? 'saved' : source, version };
  }
  return {
    get,
    active: () => copy(state.active),
    next: () => copy(state.next),
    previous: () => copy(state.previous),
    version: () => version,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** Every model name this process may embed with now or after a switch or rollback. */
    modelNames() { return [state.active, state.next, state.previous].filter(Boolean).map((t) => t.model); },
    setNext(target) {
      const t = normalizeTarget(target);
      if (sameTarget(t, state.active)) throw Object.assign(Error('That model, profile and address are already active.'), { status: 409, code: 'alreadyActive' });
      return change({ ...state, next: t });
    },
    clearNext() { return change({ ...state, next: null }); },
    /** next becomes active; the old active is kept as previous for rollback. */
    switchToNext() {
      if (!state.next) throw Object.assign(Error('No re-index is under way.'), { status: 409, code: 'noNext' });
      return change({ active: state.next, next: null, previous: state.active });
    },
    rollback() {
      if (!state.previous) throw Object.assign(Error('There is no previous embedding model to return to.'), { status: 409, code: 'noPrevious' });
      return change({ active: state.previous, next: null, previous: state.active });
    },
    /** Forget the rollback target (the caller drops its vectors). */
    finish() {
      if (!state.previous) throw Object.assign(Error('There is no previous embedding model to remove.'), { status: 409, code: 'noPrevious' });
      return change({ ...state, previous: null });
    },
  };
}

/**
 * createEmbeddingConfig for the server: a damaged saved file must not stop web from starting
 * (retrieval is optional). Embedding is then switched off, fail closed: the active profile is
 * unknown, so every embed call refuses and retrieval reports degraded, and nothing is saved over
 * the damaged file until an operator fixes or deletes it.
 */
function loadEmbeddingConfig({ env = process.env, stateFile = null, log = (line) => console.error(line) } = {}) {
  try {
    return createEmbeddingConfig({ env, stateFile });
  } catch (err) {
    if (err?.code !== 'badState') throw err;
    log(`[embedding] ${err.message} Embeddings are off until then.`);
    const off = createEmbeddingConfig({ env: { EMBEDDING_MODEL: 'unavailable', EMBEDDING_PROFILE: 'unavailable' }, stateFile: null });
    return { ...off, damaged: err.message, setNext() { throw Object.assign(Error(err.message), { status: 409, code: 'badState' }); } };
  }
}

// The process's config, for modules that are not handed one (model-system.cjs's delete guard,
// llamacpp-manager.cjs's keep-alongside list). Set once by index.cjs.
let installed = null;
function install(config) { installed = config; return config; }
function current() { return installed; }

module.exports = { createEmbeddingConfig, loadEmbeddingConfig, normalizeTarget, seedFromEnv, identityOf, sameIdentity, sameTarget, install, current };
