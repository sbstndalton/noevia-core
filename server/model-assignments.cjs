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
// #2252 (#2238): `state` is CONFIGURATION, never reachability. 'active' means a model or an address is set up
// (and installed); this module is pure and sends nothing, so a service whose address is closed still reads
// 'active' here. Whether a service answers is GET /api/models/machines?health=1 (administrators; one cached,
// bounded probe per address, machine-health.cjs), which the Models page joins to these rows and words as
// Running / Unreachable. A member's page has no probe and says "Configured", never "Running". A `reachable`
// field here would need that probe on this route's every cold call (up to the probe timeout, from a member's
// request too), so it is left out on purpose.
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
function modelAssignments({ installed, env = {}, embedding = null, isSystem = () => false, admin = false, served = null, service = null, decision = null, rerank = null }) {
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

  // #1665: `rerank` is rerank-settings.cjs; its effective environment (the admin's saved switch over the
  // deployment's) is what retrieval uses, so the row reads it too. Without it: the deployment's, as before.
  const renv = rerank && typeof rerank.effectiveEnv === 'function' ? rerank.effectiveEnv() : env;
  const rerankOn = truthy(renv.NOEVIA_FEATURE_RAG_RERANK);
  const rerankModel = String(renv.RERANK_MODEL || '').trim() || null;
  // #1695: a configured reranker whose file is gone reads "missing" even while reranking is
  // switched off, so the row never says just "Off" for a model that no longer exists.
  // #1665: a TEI reranker (RERANK_BACKEND=tei) is served by its own sidecar, not from the installed
  // GGUF list, so its name is never "missing" from that list and there is nothing to pick from it.
  const teiRerank = String(renv.RERANK_BACKEND || '').trim().toLowerCase() === 'tei';
  const rerankState = teiRerank ? (rerankOn ? 'active' : 'off')
    : rerankModel && list.length && stateOf(rerankModel) === 'missing' ? 'missing' : rerankOn ? stateOf(rerankModel) : 'off';
  // #1665: admins get the runtime switch: `enabled`, the chosen id, where it comes from and the choices
  // ({ id, backend, model }; never an address). `options` stays the plain installed names (#1695 wording).
  const switchable = rerank ? rerank.get(Array.isArray(installed) ? installed : null) : null;
  services.push({ id: 'reranker', model: rerankModel, state: rerankState, canChange: admin && !!switchable,
    ...(admin ? { options: teiRerank ? [] : list.filter((m) => !m.missingFile && isRerankModel(m)).map((m) => m.name) } : {}),
    ...(admin && switchable ? { enabled: switchable.enabled, choice: switchable.choice, source: switchable.source, choices: switchable.options } : {}) });

  // #1796: the decision service and the sensitivity check are what decision-settings.cjs sends to (the
  // shared URL from Settings or COWORK_DECISION_URL, with COWORK_DECISION_MODEL), never an installed
  // preset marked as Laya: that stale entry said laya_multilingual_f16 while every decision went to Kev.
  const { describeDecision } = require('./decision-settings.cjs');
  const d = decision || describeDecision(env);
  // #1666: admins also get the decision model ids they can choose in Decision service setup and the deployment's own.
  const { DECISION_MODELS } = require('./decision-settings.cjs');
  const { profileFor } = require('./decision-models.cjs');
  services.push({ id: 'decision', model: d.decision.model, state: d.decision.state, canChange: false, ...(admin ? { source: d.decision.source, ...(d.decision.modelSource ? { modelSource: d.decision.modelSource } : {}),
    models: [...DECISION_MODELS], deploymentModel: profileFor(env.COWORK_DECISION_MODEL).id } : {}) });
  services.push({ id: 'sensitivity', model: d.sensitivity.model, state: d.sensitivity.state, canChange: false, shared: d.sensitivity.shared === true });

  // #1841: a worker assigned to a machine on Settings → Inference machines counts as set up.
  const workers = require('./document-workers.cjs');
  services.push({ id: 'ocr', model: null, state: String(env.OCR_BASE_URL || '').trim() || workers.assigned('ocr') ? 'active' : 'off', canChange: false });
  services.push({ id: 'documents', model: null, state: String(env.DOCLING_BASE_URL || '').trim() || workers.assigned('documents') ? 'active' : 'off', canChange: false });

  return { admin, services };
}

/** Which service holds `name` right now, for a refused delete (409) to name it. */
function serviceUsing(name, assignments) {
  const hit = (assignments?.services || []).find((s) => s.model === name || s.next === name);
  return hit ? hit.id : null;
}

module.exports = { modelAssignments, embeddingProfileFor, serviceUsing };
