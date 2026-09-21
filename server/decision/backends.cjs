'use strict';
// Decision backends (docs/research/system-one/04 §4.4). Each answers `rank` for now; `choice` and
// the llama-logit backend come with the routing prototype.

/** Cosine order from embeddings the caller already has — today's RAG behaviour, as a backend. */
function embedBackend() {
  return {
    id: 'embed', locality: 'local',
    supports: (kind) => kind === 'rank',
    async decide(request) {
      const scores = Object.fromEntries(request.items.map((item) => [item.id, Number(item.score) || 0]));
      return { selected: order(scores), scores, confidence: null, metadata: { calibrated: false } };
    },
  };
}

/**
 * llama.cpp `/v1/rerank` with a cross-encoder reranker GGUF (e.g. Qwen3-Reranker-0.6B, run with
 * `--reranking --pooling rank`). Scores are relevance logits, not probabilities: `rank` only.
 */
function llamaRerankBackend({ baseUrl, model = null, apiKey = null, fetchImpl = globalThis.fetch, maxDocChars = 4000 }) {
  const url = `${String(baseUrl).replace(/\/+$/, '').replace(/\/v1$/, '')}/v1/rerank`;
  return {
    id: 'llama-rerank', locality: 'local',
    supports: (kind) => kind === 'rank',
    async decide(request) {
      const documents = request.items.map((item) => String(item.label ?? '').slice(0, maxDocChars));
      const r = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({ ...(model ? { model } : {}), query: String(request.question), documents, top_n: documents.length }),
      });
      if (!r.ok) throw Error(`rerank ${r.status}`);
      const body = await r.json();
      const rows = Array.isArray(body.results) ? body.results : [];
      const scores = {};
      for (const row of rows) {
        const item = request.items[row.index];
        if (item && Number.isFinite(row.relevance_score)) scores[item.id] = row.relevance_score;
      }
      if (Object.keys(scores).length !== request.items.length) throw Error('rerank returned a partial result');
      return { selected: order(scores), scores, confidence: null, metadata: { calibrated: false, model: body.model || model } };
    },
  };
}

const order = (scores) => Object.keys(scores).sort((a, b) => scores[b] - scores[a] || a.localeCompare(b));

module.exports = { embedBackend, llamaRerankBackend };
