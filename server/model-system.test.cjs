'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { isSystemModel, modelPathFromArgs, SYSTEM_MODEL_REASON, isSidecarModel, sidecarModelNames, SIDECAR_MODEL_DELETE_REASON } = require('./model-system.cjs');

test('isSystemModel matches Laya by id, case-insensitively, but not lookalike chat models', () => {
  assert.equal(isSystemModel('laya_multilingual_f16'), true);
  assert.equal(isSystemModel('LAYA_multilingual_f16'), true);
  assert.equal(isSystemModel('laya-mini'), true);
  assert.equal(isSystemModel('laya'), true);
  assert.equal(isSystemModel('synthetic'), false);
  assert.equal(isSystemModel('layax-chat'), false, 'a model merely starting with the same letters is not Laya');
});

test('isSystemModel also matches by --model path, even if the id were renamed', () => {
  assert.equal(isSystemModel('custom-id', '/models/laya_multilingual_f16/laya_multilingual_f16.gguf'), true);
  assert.equal(isSystemModel('custom-id', '/models/synthetic/synthetic.gguf'), false);
});

test('modelPathFromArgs reads the value following --model or -m', () => {
  assert.equal(modelPathFromArgs(['--model', '/models/laya_multilingual_f16/laya_multilingual_f16.gguf', '--ctx-size', '4096']),
    '/models/laya_multilingual_f16/laya_multilingual_f16.gguf');
  assert.equal(modelPathFromArgs(['-m', '/models/x.gguf']), '/models/x.gguf');
  assert.equal(modelPathFromArgs(['--embedding']), '');
  assert.equal(modelPathFromArgs(undefined), '');
});

test('SYSTEM_MODEL_REASON is distinct wording from the ordinary "not configured" skip reason', () => {
  assert.notEqual(SYSTEM_MODEL_REASON, 'Not a configured chat model');
});

test('#336: isSidecarModel matches EMBEDDING_MODEL (or its EMBED_MODEL fallback), but not the "default" placeholder', () => {
  assert.equal(isSidecarModel('nomic-embed-text-v1', { EMBEDDING_MODEL: 'nomic-embed-text-v1' }), true);
  assert.equal(isSidecarModel('nomic-embed-text-v1', { EMBED_MODEL: 'nomic-embed-text-v1' }), true, 'EMBED_MODEL is rag.cjs\'s own fallback name');
  assert.equal(isSidecarModel('nomic-embed-text-v1', { EMBEDDING_MODEL: 'default', EMBED_MODEL: 'nomic-embed-text-v1' }), false, 'EMBEDDING_MODEL="default" wins over EMBED_MODEL (same precedence as rag.cjs), so nothing is protected in that combination');
  assert.equal(isSidecarModel('other-model', { EMBEDDING_MODEL: 'nomic-embed-text-v1' }), false);
  assert.equal(isSidecarModel('default', { EMBEDDING_MODEL: 'default' }), false, 'the .env.example placeholder never protects a literal model named "default"');
  assert.equal(isSidecarModel('', { EMBEDDING_MODEL: 'nomic-embed-text-v1' }), false);
  assert.equal(isSidecarModel('nomic-embed-text-v1', {}), false, 'nothing is protected when EMBEDDING_MODEL is unset');
});

test('#336: isSidecarModel matches RERANK_MODEL only when NOEVIA_FEATURE_RAG_RERANK is actually on', () => {
  assert.equal(isSidecarModel('qwen3-reranker-0.6b-q8_0', { NOEVIA_FEATURE_RAG_RERANK: '1', RERANK_MODEL: 'qwen3-reranker-0.6b-q8_0' }), true);
  assert.equal(isSidecarModel('qwen3-reranker-0.6b-q8_0', { NOEVIA_FEATURE_RAG_RERANK: 'true', RERANK_MODEL: 'qwen3-reranker-0.6b-q8_0' }), true);
  assert.equal(isSidecarModel('qwen3-reranker-0.6b-q8_0', { RERANK_MODEL: 'qwen3-reranker-0.6b-q8_0' }), false, 'the feature flag is off by default');
  assert.equal(isSidecarModel('qwen3-reranker-0.6b-q8_0', { NOEVIA_FEATURE_RAG_RERANK: '0', RERANK_MODEL: 'qwen3-reranker-0.6b-q8_0' }), false);
});

test('#336: sidecarModelNames can hold both the embedding model and the reranker at once', () => {
  const names = sidecarModelNames({ EMBEDDING_MODEL: 'nomic-embed-text-v1', NOEVIA_FEATURE_RAG_RERANK: 'on', RERANK_MODEL: 'qwen3-reranker-0.6b-q8_0' });
  assert.deepEqual([...names].sort(), ['nomic-embed-text-v1', 'qwen3-reranker-0.6b-q8_0']);
});

test('SIDECAR_MODEL_DELETE_REASON is distinct wording from the system-model delete reason', () => {
  assert.notEqual(SIDECAR_MODEL_DELETE_REASON, 'System routing model — not deleted');
});


test('#2298 current rerank settings add protection without removing deployment or embedding seeds', () => {
  const settings = require('./fixtures/rerank-settings-reference.cjs');
  const prior = settings.current();
  const env = { EMBEDDING_MODEL: 'embed-seed', NOEVIA_FEATURE_RAG_RERANK: 'true', RERANK_BACKEND: 'llamacpp', RERANK_BASE_URL: 'http://synthetic-rerank', RERANK_MODEL: 'rerank-seed-a' };
  const store = new Map([[settings.KEY, JSON.stringify({ enabled: true, choice: 'llamacpp:rerank-current-b' })]]);
  const current = settings.createRerankSettings({ store, env });
  settings.install(current);
  try {
    assert.deepEqual([...sidecarModelNames(env)].sort(), ['embed-seed', 'rerank-current-b', 'rerank-seed-a']);
    current.save({ enabled: false, choice: 'llamacpp:rerank-current-b' }, 'synthetic-admin', [{ name: 'rerank-current-b', labels: ['reranking'] }]);
    assert.deepEqual([...sidecarModelNames(env)].sort(), ['embed-seed', 'rerank-seed-a']);
    current.reset('synthetic-admin', []);
    assert.deepEqual([...sidecarModelNames(env)].sort(), ['embed-seed', 'rerank-seed-a']);
    settings.install({ effectiveEnv: () => ({ NOEVIA_FEATURE_RAG_RERANK: 'true', RERANK_BACKEND: 'tei' }) });
    assert.deepEqual([...sidecarModelNames(env)].sort(), ['embed-seed', 'rerank-seed-a'], 'an unnamed TEI default is valid');
  } finally { settings.install(prior); }
});


test('#2298 current enabled flag follows runtime whitespace normalization without changing seed rules', () => {
  const settings = require('./fixtures/rerank-settings-reference.cjs');
  const { rerankTarget } = require('./rerank-target.cjs');
  const prior = settings.current();
  const seed = { NOEVIA_FEATURE_RAG_RERANK: ' true ', RERANK_MODEL: 'rerank-seed-a' };
  const current = settings.createRerankSettings({ store: new Map(), env: { ...seed, RERANK_MODEL: 'rerank-current-b', RERANK_BACKEND: 'llamacpp', RERANK_BASE_URL: 'http://synthetic-rerank' }, machine: () => ({ url: 'http://synthetic-machine', protocol: 'llamacpp' }) });
  settings.install(current);
  try {
    assert.equal(rerankTarget(current.effectiveEnv()).enabled, true);
    assert.deepEqual([...sidecarModelNames(seed)], ['rerank-current-b']);
    settings.install(null);
    assert.deepEqual([...sidecarModelNames(seed)], [], 'legacy deployment-seed flag behavior stays unchanged');
  } finally { settings.install(prior); }
});
