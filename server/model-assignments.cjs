'use strict';
const { servesModel } = require('./embedding-served.cjs');
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
// configured model is not installed) | 'off' (the service is not configured or turned off) |
// 'unloaded' (#1795: embedding only, the configured model is installed but not loaded).
// #1668: `managed` marks an embedding service noevia runs itself (embedding-service.cjs): switching
// loads the model first, and `canTurnOff` offers "Turn embedding off".

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
function modelAssignments({ installed, env = {}, embedding = null, isSystem = () => false, admin = false, served = null, service = null, decision = null }) {
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
  const embedOptions = list.filter((m) => !m.missingFile && isEmbeddingModel(m) && m.name !== active).map((m) => ({ model: m.name, profile: embeddingProfileFor(m.name),
    // #1660 review: true/false = the embeddings server's /v1/models does / does not list it
    // (embedding-served.cjs matching); null = unknown (not asked, or it could not be read).
    served: Array.isArray(served) ? servesModel(served, m.name) : null }));
  // #1668: when noevia manages the embedding service, any installed embedding model can be chosen
  // (the service loads it before anything is re-indexed), and the admin can turn embedding off.
  const managed = !!service && service.managed === true;
  const serviceOff = managed && service.enabled === false;
  const embedState = next ? 'switching' : serviceOff ? 'off' : stateOf(active);
  const options = managed ? embedOptions.map((o) => ({ ...o, served: true })) : embedOptions;
  // #1795: the row and the model's card below it read the same fact. A configured embedding model whose
  // card says it is not loaded (the installed list's `loaded`, which follows the embedding service,
  // models.cjs) reads "unloaded" here too, never "Running" over an "Unloaded" card.
  const activeEntry = active ? byName.get(active) : null;
  const notLoaded = embedState === 'active' && !!activeEntry && !activeEntry.missingFile && !activeEntry.servedElsewhere && activeEntry.loaded === false;
  services.push({ id: 'embedding', model: active, state: !serviceOff && active && active.toLowerCase() === 'default' ? 'active' : notLoaded ? 'unloaded' : embedState,
    ...(next ? { next, ready: embedding?.coverage?.next?.ready === true } : {}),
    ...(managed ? { managed: true } : {}),
    canChange: admin && !!embedding,
    ...(admin && managed ? { canTurnOff: !serviceOff && !next } : {}),
    ...(admin ? { options: serviceOff ? list.filter((m) => !m.missingFile && isEmbeddingModel(m)).map((m) => ({ model: m.name, profile: embeddingProfileFor(m.name), served: true })) : options, baseUrl: embedding?.active?.baseUrl ?? null } : {}) });

  const rerankOn = truthy(env.NOEVIA_FEATURE_RAG_RERANK);
  const rerank = String(env.RERANK_MODEL || '').trim() || null;
  // #1695: a configured reranker whose file is gone reads "missing" even while reranking is
  // switched off, so the row never says just "Off" for a model that no longer exists.
  const rerankState = rerank && list.length && stateOf(rerank) === 'missing' ? 'missing' : rerankOn ? stateOf(rerank) : 'off';
  services.push({ id: 'reranker', model: rerank, state: rerankState, canChange: false,
    ...(admin ? { options: list.filter((m) => !m.missingFile && isRerankModel(m)).map((m) => m.name) } : {}) });

  // #1796: the decision service and the sensitivity check are what decision-settings.cjs sends to (the
  // shared URL from Settings or COWORK_DECISION_URL, with COWORK_DECISION_MODEL), never an installed
  // preset marked as Laya: that stale entry said laya_multilingual_f16 while every decision went to Kev.
  const { describeDecision } = require('./decision-settings.cjs');
  const d = decision || describeDecision(env);
  services.push({ id: 'decision', model: d.decision.model, state: d.decision.state, canChange: false, ...(admin ? { source: d.decision.source } : {}) });
  services.push({ id: 'sensitivity', model: d.sensitivity.model, state: d.sensitivity.state, canChange: false, shared: d.sensitivity.shared === true });

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
