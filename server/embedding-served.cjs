'use strict';
// #1660 review: does an embeddings server really serve a model name? A single-model llama-server
// answers /v1/embeddings for ANY model name with its own vectors, so a re-index target the server
// does not list would be embedded by another model and stored under the wrong identity.
//
// Matching: `name` and `name:latest` are the same model (Ollama lists `nomic-embed-text:latest`),
// compared case-insensitively. A listed id is never turned into a name: a llama-server started
// without --alias lists the file path, and file names are not model names, so that is refused with
// a message saying how to fix it.

const MAX_ECHO = 20;
const MAX_ECHO_CHARS = 120;

const canonical = (s) => String(s ?? '').trim().toLowerCase().replace(/:latest$/, '');
const looksLikePath = (s) => /^(\/|~|\.{1,2}\/|[a-z]:[\\/])/i.test(String(s)) || /\.(gguf|bin|safetensors)$/i.test(String(s));

/** True when `ids` (what /v1/models listed) names `model`. */
function servesModel(ids, model) {
  const want = canonical(model);
  if (!want || !Array.isArray(ids)) return false;
  return ids.some((id) => typeof id === 'string' && canonical(id) === want);
}

/** The listed ids, each trimmed, for an error reply. */
const echoIds = (ids) => (Array.isArray(ids) ? ids : []).slice(0, MAX_ECHO).map((id) => String(id).slice(0, MAX_ECHO_CHARS));

/**
 * Asks `servedModels(target)` (rag.cjs) and decides. Never throws.
 * @returns {Promise<{ok:true}|{ok:false,code:'endpointUnverified'|'modelNotServed',error:string,served?:string[]}>}
 */
async function checkServed(servedModels, target) {
  const model = String(target?.model ?? '').trim();
  const shown = model.slice(0, MAX_ECHO_CHARS);
  let ids = null;
  try { ids = typeof servedModels === 'function' ? await servedModels({ baseUrl: target?.baseUrl || null, model }) : null; } catch { ids = null; }
  if (!Array.isArray(ids)) return { ok: false, code: 'endpointUnverified', error: `Could not confirm that the embeddings server serves ${shown}.` };
  if (servesModel(ids, model)) return { ok: true };
  const served = echoIds(ids);
  if (ids.length && ids.every(looksLikePath)) {
    return { ok: false, code: 'modelNotServed', served,
      error: `The embeddings server lists only a model file, not model names, so it cannot be confirmed that it serves ${shown}. Start it with --alias ${shown} (or load ${shown} there).` };
  }
  return { ok: false, code: 'modelNotServed', served, error: `The embeddings server does not serve ${shown}.` };
}

module.exports = { servesModel, checkServed, echoIds, looksLikePath, MAX_ECHO_CHARS };
