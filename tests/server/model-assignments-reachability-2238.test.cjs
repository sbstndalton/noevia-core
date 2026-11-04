'use strict';
// The public configured-vs-reachable projection is covered by the native Node-oracle wire fixtures.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createModelAssignmentsFacts, PATH } = require('../../server/rust-model-assignments-facts.cjs');

test('#2238 assignments facts reuse only the administrator served probe and redact member inputs', async () => {
  const sent = [];
  let admin = false;
  const probes = [];
  const handle = createModelAssignmentsFacts({
    secret: 'synthetic', readJson: async () => ({ admin }), json: (_res, status, body) => sent.push({ status, body }),
    env: { OCR_BASE_URL: 'http://127.0.0.1:9', EMBEDDING_API_KEY: 'secret-marker' },
    modelsInstalled: async () => [{ name: 'EmbeddingGemma-2', modelPath: '/private/path', labels: [] }],
    embeddingConfig: () => ({ active: { model: 'nomic', baseUrl: 'http://embedding.internal:9' } }),
    servedEmbeddingModels: async (target) => { probes.push(target); return ['EMBEDDINGGEMMA-2:latest', '/private/model.gguf']; },
    embeddingService: () => null, workerAssigned: () => false,
  });
  const request = { url: PATH, method: 'POST', socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-noevia-store-token': 'synthetic' } };
  assert.equal(await handle({ ...request, headers: { ...request.headers, 'x-forwarded-for': '' } }, {}), true);
  assert.equal(sent.pop().status, 404);
  assert.equal(await handle(request, {}), true);
  const member = sent.pop().body;
  assert.deepEqual(probes, []);
  assert.equal(member.ocr, true);
  assert.equal(member.embedding.baseUrl, undefined);
  assert.equal(member.installed[0].served, undefined);
  for (const secret of ['embedding.internal', '127.0.0.1', 'secret-marker', '/private/']) {
    assert.ok(!JSON.stringify(member).includes(secret));
  }
  admin = true;
  await handle(request, {});
  const owner = sent.pop().body;
  assert.deepEqual(probes, [{ baseUrl: 'http://embedding.internal:9' }]);
  assert.equal(owner.installed[0].served, true);
  assert.equal(owner.embedding.baseUrl, 'http://embedding.internal:9');
  assert.ok(!JSON.stringify(owner).includes('/private/'));
});
