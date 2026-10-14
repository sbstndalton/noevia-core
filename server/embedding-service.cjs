'use strict';
// #1668: the embedding SERVICE (the cowork-embed container), as the model manager runs it.
//
// The model manager (noevia-rs noevia-model-manager, /api/v1/embedding-service) owns which models
// that container serves: { models: [{ model, file }] }, at most two (the active model, and the one
// a switch is re-indexing towards), empty when embedding is off (the container is stopped). The
// environment (EMBEDDING_MODEL + EMBED_MODEL_FILE on the model manager) only seeds it once.
//
// This module is web's view of it:
//   status()          the last answer ({ managed, enabled, models, previous, running }) or null
//   refresh()         asks again (never throws)
//   serve(models)     asks the model manager to serve exactly `models` (restart / stop)
//   waitLoaded(names) polls until the service's router reports every name loaded
//   protectedNames()  model names a delete must refuse: every model the service is set to serve,
//                     may still hold (`previous`), or reports loaded (#336)
//   baseUrl           EMBEDDING_SERVICE_URL: the one address both projects and the Diary use for it
//
// When the model manager does not manage the service (no EMBED_CONTAINER there, or an older image),
// `managed()` stays false and every caller keeps the pre-#1668 behaviour.

const POLL_MS = 2000;
const STALE_MS = 15000;

function createEmbeddingService({ env = process.env, fetchJson, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = (line) => console.info(line) } = {}) {
  const loaderUrl = String(env.MODEL_LOADER_URL || '').replace(/\/+$/, '');
  const baseUrl = String(env.EMBEDDING_SERVICE_URL || '').trim().replace(/\/+$/, '') || null;
  let last = null; // { at, body }
  let lastError = null;
  let inFlight = null;

  const headers = () => ({ 'Content-Type': 'application/json', ...(env.MODEL_LOADER_TOKEN ? { 'X-Model-Loader-Token': env.MODEL_LOADER_TOKEN } : {}) });
  const url = `${loaderUrl}/api/v1/embedding-service`;

  async function refresh() {
    if (!loaderUrl || !fetchJson) return null;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const r = await fetchJson(url, { method: 'GET', headers: headers() }, 6000);
        if (r?.ok && r.body && r.body.managed === true) { last = { at: now(), body: r.body }; lastError = null; }
        else if (r && r.status === 404 && !last) { lastError = 'notManaged'; }
        else lastError = `HTTP ${r?.status ?? 'error'}`;
      } catch (err) { lastError = String(err?.message || err).slice(0, 200); }
      return last ? last.body : null;
    })().finally(() => { inFlight = null; });
    return inFlight;
  }

  const api = {
    baseUrl,
    /** True once the model manager has said it manages the service. Sticky for this process. */
    managed: () => !!last,
    status: () => (last ? { ...last.body, stale: now() - last.at > STALE_MS, ...(lastError ? { lastError } : {}) } : null),
    enabled: () => !!last && last.body.enabled === true,
    refresh,
    async serve(models) {
      if (!loaderUrl || !fetchJson) throw Object.assign(Error('The model manager is not configured.'), { status: 503, code: 'serviceUnavailable' });
      const r = await fetchJson(url, { method: 'PUT', headers: headers(), body: JSON.stringify({ models }) }, 60000);
      if (!r?.ok) {
        const detail = String(r?.body?.detail || r?.body?.error || `HTTP ${r?.status}`).slice(0, 300);
        throw Object.assign(Error(`The embedding service could not be changed: ${detail}`), { status: r?.status === 400 ? 400 : 502, code: 'serviceRefused' });
      }
      if (r.body?.managed) last = { at: now(), body: r.body };
      log(`[embedding] service now serves ${models.length ? models.map((m) => m.model).join(', ') : 'nothing (off)'}`);
      return api.status();
    },
    /** Resolves true once every name is loaded, false after `timeoutMs`. */
    async waitLoaded(names, { timeoutMs = 180000 } = {}) {
      const deadline = now() + timeoutMs;
      for (;;) {
        const s = await refresh();
        const loaded = new Set(s?.running?.loaded || []);
        if (s && names.every((n) => loaded.has(n))) return true;
        if (now() >= deadline) return false;
        await sleep(POLL_MS);
      }
    },
    protectedNames() {
      const names = new Set();
      if (!last) return names;
      const b = last.body;
      for (const e of [...(b.models || []), ...(b.previous || [])]) {
        if (e?.model) names.add(e.model);
        if (e?.file) { names.add(e.file); names.add(String(e.file).split('/').pop().replace(/\.gguf$/i, '')); }
      }
      for (const id of b.running?.loaded || []) names.add(id);
      return names;
    },
    /** The file the service serves (or last served) under `model`, if known. */
    fileOf(model) {
      const b = last?.body;
      return [...(b?.models || []), ...(b?.previous || [])].find((e) => e.model === model)?.file || null;
    },
  };
  return api;
}

/**
 * The models-dir-relative GGUF of an installed model, from the model manager's own list, by model
 * id, alias (models.ini section) or name. Never trusts a path from the browser. null when unknown.
 */
async function resolveModelFile({ env = process.env, fetchJson, model }) {
  const loaderUrl = String(env.MODEL_LOADER_URL || '').replace(/\/+$/, '');
  const want = String(model || '').trim();
  if (!loaderUrl || !want) return null;
  const r = await fetchJson(`${loaderUrl}/api/v1/models`, { method: 'GET', headers: { 'Content-Type': 'application/json', ...(env.MODEL_LOADER_TOKEN ? { 'X-Model-Loader-Token': env.MODEL_LOADER_TOKEN } : {}) } }, 8000);
  const rows = Array.isArray(r?.body) ? r.body : Array.isArray(r?.body?.models) ? r.body.models : [];
  const hit = rows.find((m) => m && !m.companion && typeof m.file === 'string' && /\.gguf$/i.test(m.file)
    && (m.modelId === want || (Array.isArray(m.sections) && m.sections.includes(want)) || m.name === want || m.stem === want));
  return hit ? hit.file : null;
}

let installed = null;
function install(service) { installed = service; return service; }
function current() { return installed; }

module.exports = { createEmbeddingService, resolveModelFile, install, current };
