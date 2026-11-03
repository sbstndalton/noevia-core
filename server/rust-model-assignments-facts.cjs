'use strict';
const { trustedFront } = require('./trusted-front.cjs');
const { servesModel } = require('./embedding-served.cjs');
const { describeDecision, DECISION_MODELS } = require('./decision-settings.cjs');
const { profileFor } = require('./decision-models.cjs');

const PATH = '/internal/model-assignments/facts';
const CAP = 8 * 1024 * 1024;
const configured = (value) => /^(1|true|on)$/i.test(String(value || '').trim());

function createModelAssignmentsFacts({
  secret, json, readJson, env, modelsInstalled, decisionSettings, rerankSettings,
  embeddingConfig = () => require('./embedding-config.cjs').current()?.get(),
  servedEmbeddingModels = (target) => require('./rag.cjs').servedModelsCached(target),
  embeddingService = () => require('./embedding-service.cjs').current()?.status(),
  workerAssigned = (kind) => require('./document-workers.cjs').assigned(kind),
}) {
  return async function handle(req, res) {
    if (req.url !== PATH) return false;
    if (req.method !== 'POST' || !trustedFront(req, secret) || Object.hasOwn(req.headers, 'x-forwarded-for') || Object.hasOwn(req.headers, 'x-noevia-client-ip')) {
      json(res, 404, { error: 'Not found' });
      return true;
    }
    let ask;
    try { ask = await readJson(req, 256); } catch { json(res, 400, { error: 'Invalid model assignments facts request.' }); return true; }
    if (!ask || Object.keys(ask).length !== 1 || typeof ask.admin !== 'boolean') {
      json(res, 400, { error: 'Invalid model assignments facts request.' });
      return true;
    }
    const { admin } = ask;
    try {
      let installed = null;
      try { installed = await modelsInstalled(); } catch { /* unavailable */ }
      let embedding = null;
      try { embedding = embeddingConfig() || null; } catch { /* unavailable */ }
      let served = null;
      if (admin) {
        try { served = await servedEmbeddingModels({ baseUrl: embedding?.active?.baseUrl || null }); } catch { /* unknown */ }
      }
      const service = embeddingService();
      const renv = rerankSettings?.effectiveEnv?.() || env;
      const choices = rerankSettings?.get(Array.isArray(installed) ? installed : null);
      const decision = decisionSettings?.describe() || describeDecision(env);
      const facts = {
        installed: Array.isArray(installed) ? installed.map(m => ({
          name: m.name, labels: m.labels || [], missingFile: !!m.missingFile,
          servedElsewhere: !!m.servedElsewhere, unloaded: m.loaded === false,
          ...(admin ? { served: Array.isArray(served) ? servesModel(served, m.name) : null } : {}),
        })) : null,
        embedding: {
          active: embedding?.active?.model || String(env.EMBEDDING_MODEL || env.EMBED_MODEL || '').trim() || null,
          next: embedding?.next?.model || null, ready: embedding?.coverage?.next?.ready === true,
          configured: !!embedding, managed: service?.managed === true, enabled: service?.enabled !== false,
          ...(admin ? { baseUrl: embedding?.active?.baseUrl ?? null } : {}),
        },
        reranker: {
          model: String(renv.RERANK_MODEL || '').trim() || null,
          tei: String(renv.RERANK_BACKEND || '').trim().toLowerCase() === 'tei',
          enabled: configured(renv.NOEVIA_FEATURE_RAG_RERANK),
          ...(admin && choices ? { choice: { enabled: choices.enabled, choice: choices.choice, source: choices.source, options: choices.options.map(({ id, backend, model }) => ({ id, backend, model })) } } : {}),
        },
        decision: {
          model: decision.decision.model, state: decision.decision.state,
          ...(admin ? { source: decision.decision.source, modelSource: decision.decision.modelSource,
            models: [...DECISION_MODELS], deploymentModel: profileFor(env.COWORK_DECISION_MODEL).id } : {}),
        },
        sensitivity: { model: decision.sensitivity.model, state: decision.sensitivity.state, shared: decision.sensitivity.shared === true },
        ocr: !!String(env.OCR_BASE_URL || '').trim() || !!workerAssigned('ocr'),
        documents: !!String(env.DOCLING_BASE_URL || '').trim() || !!workerAssigned('documents'),
      };
      if (Buffer.byteLength(JSON.stringify(facts)) > CAP) throw Error('facts exceed cap');
      json(res, 200, facts);
    } catch {
      json(res, 503, { error: 'Model assignments are unavailable.' });
    }
    return true;
  };
}
module.exports = { createModelAssignmentsFacts, PATH };
