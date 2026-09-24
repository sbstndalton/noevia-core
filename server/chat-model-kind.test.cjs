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
