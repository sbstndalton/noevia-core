'use strict';
// #1660 review / #1668: the env-named embedding model (EMBEDDING_MODEL) stays protected even when a
// saved embedding configuration has switched away from it: the embed sidecar is started from compose
// with that file fixed, so deleting it would crash-loop the sidecar on restart (#336).
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

test('no configuration installed: the env-named model is protected', () => {
  assert.equal(isSidecarModel('nomic-embed-text-v1', env), true);
});

test('a saved configuration switched away (and finished) STILL protects the env-named model (#1668)', () => {
  config.install(fake('saved', 'embeddinggemma-2'));
  assert.equal(isSidecarModel('nomic-embed-text-v1', env), true, 'the compose-started sidecar still loads it');
  assert.equal(isSidecarModel('embeddinggemma-2', env), true, 'the saved active model is protected too');
});

test('a model neither the env nor the saved configuration names is not protected', () => {
  config.install(fake('saved', 'embeddinggemma-2'));
  assert.equal(isSidecarModel('some-other-embedder', env), false);
});
