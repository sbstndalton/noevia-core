'use strict';
// #697: where the optional RAG reranker (NOEVIA_FEATURE_RAG_RERANK) may run.
//
// The shared inference engine holds one model at a time (compose `--models-max`), inside one
// memory budget. A reranker on that engine either evicts the chat model on every retrieval or,
// on a multi-slot engine, adds a second resident outside the budget's estimate. So the reranker
// only runs against a dedicated endpoint (for example the `rerank` CPU sidecar in
// compose.rerank.yaml). RERANK_SHARED_ENGINE=allow restores the old behaviour for an operator who
// has sized the engine for it; anything else turns reranking off and retrieval keeps its cosine
// top results, the same fallback it uses when the reranker misses its deadline.

const truthy = v => /^(1|true|on)$/i.test(String(v || '').trim());

function origin(value) {
  try {
    const url = new URL(String(value || '').trim());
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch { return null; }
}

/** Origins of the shared inference engine as web is configured to reach it. */
function engineOrigins(env = process.env) {
  return new Set([env.INFERENCE_BASE_URL, env.MODEL_MANAGER_BASE_URL, env.LEMONADE_BASE_URL].map(origin).filter(Boolean));
}

/**
 * @returns {{ enabled: boolean, baseUrl: string|null, model: string|null, shared: boolean, reason: string|null }}
 *   shared: the reranker runs on the shared engine (only when RERANK_SHARED_ENGINE=allow).
 */
function rerankTarget(env = process.env) {
  const baseUrl = String(env.RERANK_BASE_URL || '').trim() || null;
  const model = String(env.RERANK_MODEL || '').trim() || null;
  if (!truthy(env.NOEVIA_FEATURE_RAG_RERANK) || !baseUrl) return { enabled: false, baseUrl, model, shared: false, reason: null };
  const target = origin(baseUrl);
  const shared = !!target && engineOrigins(env).has(target);
  if (shared && String(env.RERANK_SHARED_ENGINE || '').trim().toLowerCase() !== 'allow') {
    return { enabled: false, baseUrl, model, shared: true,
      reason: 'RERANK_BASE_URL points at the shared inference engine, which holds one model within the inference memory budget; run the reranker on its own endpoint (compose.rerank.yaml) or set RERANK_SHARED_ENGINE=allow. Retrieval uses cosine ranking.' };
  }
  return { enabled: true, baseUrl, model, shared, reason: null };
}

module.exports = { rerankTarget, engineOrigins };
