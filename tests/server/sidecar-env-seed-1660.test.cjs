'use strict';
// #1660 review (C1): EMBEDDING_MODEL only seeds the embedding configuration (#1638). Once a saved
// configuration exists and none of its active/next/previous models is the env-named one, that
// model is no longer protected, so "switch embedding, then delete the old model" completes. While
// no saved configuration exists, or it still references the model, it stays protected (#336).
const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../../server/embedding-config.cjs');
const { isSidecarModel } = require('../../server/model-system.cjs');

const env = { EMBEDDING_MODEL: 'nomic-embed-text-v1' };
const fake = (source, active, next = null, previous = null) => ({
  get: () => ({ source, active: { model: active }, next: next && { model: next }, previous: previous && { model: previous } }),
  modelNames: () => [active, next, previous].filter(Boolean),
});

test.afterEach(() => config.install(null));

test('no configuration installed: the env-named model stays protected (#336)', () => {
  config.install(null);
  assert.equal(isSidecarModel('nomic-embed-text-v1', env), true);
});

test('configuration still seeded from the environment: the env-named model stays protected', () => {
  config.install(fake('environment', 'nomic-embed-text-v1'));
  assert.equal(isSidecarModel('nomic-embed-text-v1', env), true);
});

test('saved configuration that still references the model (as previous, before finish): protected', () => {
  config.install(fake('saved', 'embeddinggemma-2', null, 'nomic-embed-text-v1'));
  assert.equal(isSidecarModel('nomic-embed-text-v1', env), true);
  assert.equal(isSidecarModel('embeddinggemma-2', env), true);
});

test('saved configuration that switched away and finished: the env-named model is free to delete', () => {
  config.install(fake('saved', 'embeddinggemma-2'));
  assert.equal(isSidecarModel('nomic-embed-text-v1', env), false);
  assert.equal(isSidecarModel('embeddinggemma-2', env), true, 'the new active model is protected');
});
