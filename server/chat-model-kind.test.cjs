'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isChatGenerationModel, nonChatAliases } = require('./chat-model-kind.cjs');

test('chat models pass; embedding, reranking and routing models do not (#206)', () => {
  assert.equal(isChatGenerationModel('synthetic-chat-7b', []), true);
  assert.equal(isChatGenerationModel('synthetic-chat-7b', ['vision']), true);
  assert.equal(isChatGenerationModel('synthetic-a', ['embeddings']), false, 'by label');
  assert.equal(isChatGenerationModel('synthetic-b', ['reranking']), false, 'by label');
  assert.equal(isChatGenerationModel('nomic-embed-text-v1', []), false, 'by name');
  assert.equal(isChatGenerationModel('qwen3-reranker-0.6b-q8_0', []), false, 'by name');
  assert.equal(isChatGenerationModel('laya_multilingual_f16', []), false, 'system routing model');
  assert.equal(isChatGenerationModel('', []), false);
});

test('nonChatAliases uses catalogue labels and falls back to names when the catalogue is unreadable', () => {
  const cat = [{ name: 'chat-x', labels: [] }, { name: 'vec-y', labels: ['embedding'] }];
  assert.deepEqual(nonChatAliases(['chat-x', 'vec-y', 'laya_multilingual_f16'], cat), ['vec-y', 'laya_multilingual_f16']);
  assert.deepEqual(nonChatAliases(['chat-x', 'nomic-embed-text-v1'], null), ['nomic-embed-text-v1']);
  assert.deepEqual(nonChatAliases(undefined, cat), []);
});

// #343 review follow-up: servedCatalogue() returns null on an unreachable engine, but callers
// should never have to know that specifically — any non-array (undefined, or a stray non-array
// value) must degrade to the same name-only fallback rather than throwing.
test('nonChatAliases never throws when catalogue is not an array, for any non-array value', () => {
  for (const catalogue of [undefined, {}, 'not-an-array', 0, false]) {
    assert.doesNotThrow(() => nonChatAliases(['chat-x', 'nomic-embed-text-v1'], catalogue));
    assert.deepEqual(nonChatAliases(['chat-x', 'nomic-embed-text-v1'], catalogue), ['nomic-embed-text-v1']);
  }
});
