'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFeatures, REGISTRY, parseEnv } = require('./features.cjs');

const memoryStore = (seed = {}) => { const m = new Map(Object.entries(seed)); return { m, get: k => m.get(k), set: (k, v) => m.set(k, v) }; };

test('every registered feature is off by default', () => {
  const features = createFeatures({ env: {}, store: memoryStore() });
  for (const name of Object.keys(REGISTRY)) assert.equal(features.enabled(name), false, name);
  assert.ok(features.names().includes('previews'));
});

test('an env var is authoritative and locks the admin toggle', () => {
  const store = memoryStore({ 'feature:previews': 'false' });
  const features = createFeatures({ env: { NOEVIA_FEATURE_PREVIEWS: 'true' }, store });
  assert.equal(features.enabled('previews'), true);
  assert.throws(() => features.set('previews', false, 'u1'), e => e.status === 409);
  assert.equal(store.m.get('feature:previews'), 'false');
  assert.equal(features.describe().find(f => f.name === 'previews').locked, true);
});

test('admin setting persists, is audited, and survives a restart', () => {
  const store = memoryStore(); const audits = [];
  const features = createFeatures({ env: {}, store, audit: (...a) => audits.push(a) });
  features.set('previews', true, 'admin1');
  assert.equal(features.enabled('previews'), true);
  assert.deepEqual(audits, [['feature.set', 'admin1', { name: 'previews', enabled: true }]]);
  assert.equal(createFeatures({ env: {}, store }).enabled('previews'), true);
});

test('values are cached: later env or store changes do not flip a running flag', () => {
  const env = {}; const store = memoryStore();
  const features = createFeatures({ env, store });
  env.NOEVIA_FEATURE_KIWIX = 'true'; store.set('feature:kiwix', 'true');
  assert.equal(features.enabled('kiwix'), false);
});

test('rejects unknown names, non-boolean values and garbage env', () => {
  const features = createFeatures({ env: {}, store: memoryStore() });
  assert.throws(() => features.enabled('nope'));
  assert.throws(() => features.set('nope', true), e => e.status === 404);
  assert.throws(() => features.set('previews', 'yes'), e => e.status === 400);
  assert.throws(() => createFeatures({ env: { NOEVIA_FEATURE_PREVIEWS: 'maybe' } }));
  assert.equal(parseEnv(' OFF '), false);
  assert.equal(parseEnv(''), undefined);
});

test('a corrupt stored value falls back to off', () => {
  assert.equal(createFeatures({ env: {}, store: memoryStore({ 'feature:previews': '1' }) }).enabled('previews'), false);
});

test('flags() exposes booleans only', () => {
  const flags = createFeatures({ env: {}, store: memoryStore() }).flags();
  for (const v of Object.values(flags)) assert.equal(typeof v, 'boolean');
});

test('features wired at startup report a pending restart instead of pretending to be live', () => {
  const m = new Map();
  const features = createFeatures({ env: {}, store: { get: (k) => m.get(k), set: (k, v) => m.set(k, v) } });
  features.set('kiwix', true, 'admin');
  assert.equal(features.enabled('kiwix'), false, 'the running server still has no Kiwix tools');
  const row = features.describe().find((f) => f.name === 'kiwix');
  assert.deepEqual([row.enabled, row.pendingRestart], [true, true]);
  features.set('kiwix', false, 'admin');
  assert.equal(features.describe().find((f) => f.name === 'kiwix').pendingRestart, false);
  features.set('previews', true, 'admin');
  assert.equal(features.enabled('previews'), true, 'live features apply at once');
  assert.equal(features.describe().find((f) => f.name === 'previews').pendingRestart, false);
  assert.equal(createFeatures({ env: {}, store: { get: (k) => m.get(k), set() {} } }).enabled('previews'), true);
});
