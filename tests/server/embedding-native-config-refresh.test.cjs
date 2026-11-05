'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createEmbeddingConfig } = require('../../server/embedding-config.cjs');
const evidence = process.env.EMBEDDING_TEST_ROOT;
function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(evidence || require('node:os').tmpdir(), 'embedding-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'embedding-config.json');
}
function publish(file, model) {
  fs.writeFileSync(`${file}.native.tmp`, JSON.stringify({ version: 1, active: { model, profile: 'nomic-v1', baseUrl: null }, next: null, previous: null }));
  fs.renameSync(`${file}.native.tmp`, file);
}
test('paired Node readers observe external config before any retrieval and notify caches once', (t) => {
  const stateFile = sandbox(t);
  const config = createEmbeddingConfig({ env: { EMBEDDING_MODEL: 'fixture-old' }, stateFile, nativeOwner: {} });
  let changes = 0;
  config.onChange(() => { changes++; assert.equal(config.get().active.model, 'fixture-new'); });
  const oldVersion = config.version();
  publish(stateFile, 'fixture-new');
  assert.equal(config.active().model, 'fixture-new');
  assert.equal(config.get().source, 'saved');
  assert.equal(config.version(), oldVersion + 1);
  assert.equal(changes, 1);
  config.modelNames(); config.get(); config.next(); config.previous();
  assert.equal(changes, 1);
});
test('paired config fails closed after external corruption or removal', (t) => {
  const stateFile = sandbox(t);
  publish(stateFile, 'fixture-old');
  const config = createEmbeddingConfig({ env: {}, stateFile, nativeOwner: {} });
  fs.writeFileSync(stateFile, '{');
  assert.throws(() => config.active(), { code: 'badState' });
  fs.unlinkSync(stateFile);
  assert.throws(() => config.get(), { code: 'badState' });
  publish(stateFile, 'fixture-recovered');
  assert.equal(config.active().model, 'fixture-recovered');
});
test('legacy in-memory owner does not reload external state', (t) => {
  const stateFile = sandbox(t);
  const config = createEmbeddingConfig({ env: { EMBEDDING_MODEL: 'fixture-old' }, stateFile });
  publish(stateFile, 'fixture-new');
  assert.equal(config.active().model, 'fixture-old');
});
