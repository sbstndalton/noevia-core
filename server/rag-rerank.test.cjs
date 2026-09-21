'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { rerankPool } = require('./rag.cjs');
const { createDecisions } = require('./decision/index.cjs');
const { llamaRerankBackend } = require('./decision/backends.cjs');

const pool = Array.from({ length: 10 }, (_, i) => ({ file: 'f.md', body: `chunk ${i}`, score: 1 - i / 20 }));
const decisionsWith = (fetchImpl) => createDecisions({
  backends: { 'llama-rerank': llamaRerankBackend({ baseUrl: 'http://rerank', fetchImpl }) },
  chains: { 'rag.rerank': ['llama-rerank'] },
});
const reversed = async (_url, init) => {
  const { documents } = JSON.parse(init.body);
  return { ok: true, json: async () => ({ results: documents.map((_, index) => ({ index, relevance_score: index })) }) };
};

test('rerank reorders the pool and keeps the configured count', async () => {
  const hits = await rerankPool({ query: 'q', pool, decisions: decisionsWith(reversed), keep: 3, deadlineMs: 500 });
  assert.deepEqual(hits.map((h) => h.body), ['chunk 9', 'chunk 8', 'chunk 7']);
});

test('a down, slow or malformed reranker falls back to cosine top-6', async () => {
  const cases = [
    async () => ({ ok: false, status: 503 }),
    () => new Promise((r) => setTimeout(() => r(reversed(null, { body: '{"documents":[]}' })), 300)),
    async () => ({ ok: true, json: async () => ({ results: [{ index: 99, relevance_score: 1 }] }) }),
  ];
  for (const f of cases) {
    const hits = await rerankPool({ query: 'q', pool, decisions: decisionsWith(f), keep: 3, deadlineMs: 100 });
    assert.deepEqual(hits.map((h) => h.body), pool.slice(0, 6).map((h) => h.body));
  }
});

test('no reranker configured means today\'s behaviour', async () => {
  assert.deepEqual(await rerankPool({ query: 'q', pool, decisions: null, keep: 3, deadlineMs: 100 }), pool.slice(0, 6));
});
