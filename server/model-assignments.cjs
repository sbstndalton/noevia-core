'use strict';
// #1662: "what each service uses", the first section of Settings → Models. One entry per
// model-backed service; the chat roles come from /api/auto-roles beside it. Pure: the route
// passes the installed list, the environment and the embedding configuration in.
//
// Members see the same names read-only. Nothing here names an environment variable, and no
// address reaches a member: a service is described by its model and a state id the client words.
// The one address sent is the embedding service's, to admins only, because switching the
// embedding model (embedding settings 'set-next') needs it.
//
// state ids: 'active' | 'switching' (a re-index to `next` is under way) | 'missing' (the
// configured model is not installed) | 'off' (the service is not configured or turned off).

const truthy = (v) => /^(1|true|on)$/i.test(String(v || '').trim());

/** The embedding profile a model needs (embedding-profile.cjs). Unknown models get the plain profile. */
function embeddingProfileFor(model) {
  return /embedding-?gemma/i.test(String(model || '')) ? 'embeddinggemma-2' : 'nomic-v1';
}

const isEmbeddingModel = (m) => (m.labels || []).some((l) => /^embedding/i.test(l)) || /embed/i.test(m.name);
const isRerankModel = (m) => (m.labels || []).some((l) => /^rerank/i.test(l)) || /rerank/i.test(m.name);

/**
 * @param {{ installed: {name:string,labels?:string[],missingFile?:boolean,system?:boolean,loaded?:boolean}[]|null,
 *           env: object, embedding: {active?:{model:string,profile:string}|null,next?:{model:string}|null,coverage?:object}|null,
 *           isSystem: (name:string) => boolean, admin: boolean }} input
 */
function modelAssignments({ installed, env = {}, embedding = null, isSystem = () => false, admin = false }) {
  const list = Array.isArray(installed) ? installed : [];
  const byName = new Map(list.map((m) => [m.name, m]));
  const stateOf = (model) => {
    if (!model) return 'off';
    const m = byName.get(model);
    if (!m && list.length) return 'missing';
    if (m && m.missingFile) return 'missing';
    return 'active';
  };
  const services = [];

  const active = embedding?.active?.model || String(env.EMBEDDING_MODEL || env.EMBED_MODEL || '').trim() || null;
  const next = embedding?.next?.model || null;
  const embedOptions = list.filter((m) => !m.missingFile && isEmbeddingModel(m) && m.name !== active).map((m) => ({ model: m.name, profile: embeddingProfileFor(m.name) }));
  const embedState = next ? 'switching' : stateOf(active);
  services.push({ id: 'embedding', model: active, state: active && active.toLowerCase() === 'default' ? 'active' : embedState,
    ...(next ? { next, ready: embedding?.coverage?.next?.ready === true } : {}),
    canChange: admin && !!embedding, ...(admin ? { options: embedOptions, baseUrl: embedding?.active?.baseUrl ?? null } : {}) });

  const rerankOn = truthy(env.NOEVIA_FEATURE_RAG_RERANK);
  const rerank = String(env.RERANK_MODEL || '').trim() || null;
  services.push({ id: 'reranker', model: rerank, state: rerankOn ? stateOf(rerank) : 'off', canChange: false,
    ...(admin ? { options: list.filter((m) => !m.missingFile && isRerankModel(m)).map((m) => m.name) } : {}) });

  const laya = list.find((m) => m.system === true || isSystem(m.name));
  services.push({ id: 'decision', model: laya ? laya.name : null, // #1660 review: Auto always expects a decision model; with Laya deleted it falls back to keeping
  // those turns on this server, so the row reads "missing", never "off" or "running".
  state: laya && !laya.missingFile ? 'active' : 'missing', canChange: false });

  services.push({ id: 'ocr', model: null, state: String(env.OCR_BASE_URL || '').trim() ? 'active' : 'off', canChange: false });
  services.push({ id: 'documents', model: null, state: String(env.DOCLING_BASE_URL || '').trim() ? 'active' : 'off', canChange: false });

  return { admin, services };
}

/** Which service holds `name` right now, for a refused delete (409) to name it. */
function serviceUsing(name, assignments) {
  const hit = (assignments?.services || []).find((s) => s.model === name || s.next === name);
  return hit ? hit.id : null;
}

module.exports = { modelAssignments, embeddingProfileFor, serviceUsing };
