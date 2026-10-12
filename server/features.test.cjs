'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFeatures, REGISTRY, parseEnv } = require('./features.cjs');

const memoryStore = (seed = {}) => { const m = new Map(Object.entries(seed)); return { m, get: k => m.get(k), set: (k, v) => m.set(k, v) }; };

test('storage read ownership requires exact selector, confirmations and native auth', () => {
  const { rustStorageReadsOwned } = require('./features.cjs');
  const confirmed = {
    NOEVIA_FRONT: 'rust', NOEVIA_RUST_AUTH: '1', NOEVIA_RUST_AUTH_CONFIRMED: '1',
    NOEVIA_RUST_STORAGE_READS: '1', NOEVIA_RUST_STORAGE_READS_CONFIRMED: '1',
  };
  assert.equal(rustStorageReadsOwned(confirmed), true);
  assert.equal(rustStorageReadsOwned({}), false);
  for (const key of Object.keys(confirmed)) {
    for (const value of [undefined, '', '0', 'true', '01', ' 1 ', '1\n', 'node']) {
      assert.equal(rustStorageReadsOwned({ ...confirmed, [key]: value }), false, `${key}=${JSON.stringify(value)}`);
    }
  }
  const features = createFeatures({ env: confirmed, store: memoryStore() });
  assert.equal(features.names().includes('rustStorageReads'), false);
  assert.equal(Object.values(REGISTRY).some(row => row.env === 'NOEVIA_RUST_STORAGE_READS'), false);
  assert.throws(() => features.set('rustStorageReads', true, 'synthetic-admin'), e => e.status === 404);
});

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

test('toolGate is experimental, off by default and unavailable until the decision service is configured', () => {
  const { createFeatures: make } = require('./features.cjs');
  const off = make({ env: {} });
  const info = off.describe().find((f) => f.name === 'toolGate');
  assert.equal(info.experimental, true); assert.equal(info.enabled, false); assert.equal(info.env, 'NOEVIA_FEATURE_TOOL_GATE');
  assert.match(info.unavailable, /COWORK_DECISION_URL/);
  assert.equal(off.enabled('toolGate'), false);
  const pinned = make({ env: { NOEVIA_FEATURE_TOOL_GATE: 'true', COWORK_DECISION_URL: 'http://laya:8040' } });
  assert.equal(pinned.enabled('toolGate'), true);
  assert.equal(make({ env: { NOEVIA_FEATURE_TOOL_GATE: 'true' } }).enabled('toolGate'), false, 'unavailable wins over the env pin');
});

test('browserRuntimeReason: missing playwright, missing Chromium, and a complete runtime (issue 550)', () => {
  const { browserRuntimeReason } = require('./features.cjs');
  const missing = () => { throw Object.assign(new Error('nope'), { code: 'MODULE_NOT_FOUND' }); };
  assert.match(browserRuntimeReason({ resolve: missing }), /Playwright installed/);
  const pw = { chromium: { executablePath: () => '/ms/chromium' } };
  assert.match(browserRuntimeReason({ resolve: () => 'x', load: () => pw, exists: () => false }), /Chromium/);
  assert.match(browserRuntimeReason({ resolve: () => 'x', load: () => { throw new Error('boom'); }, exists: () => true }), /Chromium/);
  assert.equal(browserRuntimeReason({ resolve: () => 'x', load: () => pw, exists: p => p === '/ms/chromium' }), null);
});

test('Browser mode is described as unavailable, cannot be switched on and never reads as enabled when the runtime is missing', () => {
  const reason = 'Needs Playwright installed on this server; it is not in this image.';
  const registry = { ...REGISTRY, browserExecutor: { ...REGISTRY.browserExecutor, unavailable: () => reason } };
  const features = createFeatures({ env: { NOEVIA_FEATURE_BROWSER_EXECUTOR: 'true' }, store: memoryStore(), registry });
  assert.equal(features.enabled('browserExecutor'), false);
  assert.equal(features.flags().browserExecutor, false);
  const d = features.describe().find(f => f.name === 'browserExecutor');
  assert.equal(d.unavailable, reason);
  assert.equal(d.experimental, undefined);
  const admin = createFeatures({ env: {}, store: memoryStore(), registry });
  assert.throws(() => admin.set('browserExecutor', true, 'a1'), e => e.status === 409 && e.message === reason);
  assert.equal(admin.set('browserExecutor', false, 'a1'), false);
});

test('Browser mode can be switched on once the runtime is present, and flags without a probe stay unmarked', () => {
  const registry = { ...REGISTRY, browserExecutor: { ...REGISTRY.browserExecutor, unavailable: () => null } };
  const features = createFeatures({ env: {}, store: memoryStore(), registry });
  features.set('browserExecutor', true, 'a1');
  assert.equal(features.enabled('browserExecutor'), true);
  assert.equal(features.describe().find(f => f.name === 'browserExecutor').unavailable, null);
  assert.equal('unavailable' in features.describe().find(f => f.name === 'previews'), false);
});

test('the registered Browser mode probe is the real runtime check', () => {
  assert.equal(typeof REGISTRY.browserExecutor.unavailable, 'function');
  const r = REGISTRY.browserExecutor.unavailable({});
  assert.ok(r === null || typeof r === 'string');
});

test('every feature is described with a stable id equal to its flag name, for the client to translate by (#618)', () => {
  const features = createFeatures({ env: {}, store: memoryStore() });
  const described = features.describe();
  assert.deepEqual(described.map(f => f.id), Object.keys(REGISTRY));
  for (const f of described) {
    assert.equal(f.id, f.name, 'the id is the flag name');
    assert.match(f.id, /^[a-z][A-Za-z0-9]*$/, 'a key-safe identifier');
    assert.ok(f.label && f.description, 'the English label and description stay as the fallback');
  }
});

test('the reasons a feature is unavailable carry a stable id where the server owns the text (#618)', () => {
  const { unavailableId, browserRuntimeReason } = require('./features.cjs');
  assert.equal(unavailableId('browserExecutor', browserRuntimeReason({ resolve: () => { throw new Error('no'); } })), 'browserPlaywright');
  assert.equal(unavailableId('browserExecutor', browserRuntimeReason({ resolve: () => 'x', load: () => { throw new Error('no'); } })), 'browserChromium');
  assert.equal(unavailableId('browserExecutor', null), null);
  assert.equal(unavailableId('constrainedPlanDecoding', 'Not used yet: no task runs the Planner’s plan step.'), 'notUsed');
  assert.equal(unavailableId('nativeClientAuth', 'Needs TRUST_PROXY on so sign-in limits can tell clients apart.'), 'trustProxy');
  assert.equal(unavailableId('toolGate', 'Some new reason nobody wrote an id for.'), null, 'an unknown reason has no id and stays English');
  // #624: the decision-service reasons carry ids too, whichever experiment shows them.
  const url = 'Connect a private decision service with COWORK_DECISION_URL, then restart Noevia.';
  for (const name of ['stepSupervision', 'toolGate', 'systemOneRouting']) assert.equal(unavailableId(name, url), 'decisionUrl');
  assert.equal(unavailableId('toolGate', 'Set up the decision service below before enabling this experiment.'), 'decisionSetup');
  assert.equal(unavailableId('systemOneRouting', 'Not configured. Set COWORK_SYSTEM_ONE_URL to a dedicated local llama.cpp decision-model endpoint, then restart the app.'), 'systemOneUrl');
  assert.equal(unavailableId('previews', url), null, 'only the decision-service experiments use these ids');
  const info = createFeatures({ env: {}, store: memoryStore() }).describe();
  assert.equal(info.find(f => f.id === 'nativeClientAuth').unavailableId, 'trustProxy');
  // #705: the pipeline runs the Planner's plan step, so constrained decoding is available now.
  assert.equal(info.find(f => f.id === 'constrainedPlanDecoding').unavailable, null);
  assert.equal(info.find(f => f.id === 'codePipeline').unavailableId, 'codeSandbox');
  assert.equal(info.find(f => f.id === 'codeMerge').unavailableId, 'codeSandbox');
  assert.equal('unavailableId' in info.find(f => f.id === 'previews'), false);
});

// astraReview was renamed plannerReview (2026-09-29). Back-compat kept: the stored setting is
// migrated on boot (old row kept) and the old name is accepted as an alias. The old env var is gone.
test('plannerReview: a stored astraReview setting is copied to the new key on boot, and the old row is left', () => {
  const store = memoryStore({ 'feature:astraReview': 'true' }); const lines = [];
  const features = createFeatures({ env: {}, store, log: l => lines.push(l) });
  assert.equal(features.enabled('plannerReview'), true);
  assert.equal(features.describe().find(f => f.name === 'plannerReview').source, 'admin');
  assert.equal(store.m.get('feature:plannerReview'), 'true');
  assert.equal(store.m.get('feature:astraReview'), 'true', 'the legacy row stays for a rollback');
  assert.equal(lines.length, 1);
  // A second boot reads the new key and does not migrate again.
  lines.length = 0;
  assert.equal(createFeatures({ env: {}, store, log: l => lines.push(l) }).enabled('plannerReview'), true);
  assert.deepEqual(lines, []);
});

test('plannerReview: the new stored key wins over the legacy one, garbage legacy values are ignored', () => {
  const store = memoryStore({ 'feature:astraReview': 'true', 'feature:plannerReview': 'false' });
  assert.equal(createFeatures({ env: {}, store, log: () => {} }).enabled('plannerReview'), false);
  assert.equal(store.m.get('feature:plannerReview'), 'false');
  const junk = memoryStore({ 'feature:astraReview': 'maybe' });
  assert.equal(createFeatures({ env: {}, store: junk, log: () => {} }).enabled('plannerReview'), false);
  assert.equal(junk.m.has('feature:plannerReview'), false);
});

test('plannerReview: a store that cannot be written still honours the legacy value for this boot', () => {
  const store = { get: k => (k === 'feature:astraReview' ? 'true' : undefined), set: () => { throw new Error('read-only'); } };
  const lines = [];
  assert.equal(createFeatures({ env: {}, store, log: l => lines.push(l) }).enabled('plannerReview'), true);
  assert.match(lines[0], /could not migrate/);
});

test('plannerReview: stays off by default, and nothing is written when there is nothing to migrate', () => {
  const store = memoryStore();
  const features = createFeatures({ env: {}, store, log: () => {} });
  assert.equal(features.enabled('plannerReview'), false);
  assert.equal(store.m.size, 0);
  assert.equal(REGISTRY.plannerReview.default, undefined);
  assert.equal('astraReview' in REGISTRY, false);
});

test('plannerReview: the removed NOEVIA_FEATURE_ASTRA_REVIEW env var is ignored, and only the new env var pins it', () => {
  const lines = [];
  const legacy = createFeatures({ env: { NOEVIA_FEATURE_ASTRA_REVIEW: 'true' }, store: memoryStore(), log: l => lines.push(l) });
  assert.equal(legacy.enabled('plannerReview'), false);
  assert.equal(legacy.describe().find(f => f.name === 'plannerReview').locked, false);
  assert.deepEqual(lines, []);
  assert.equal(createFeatures({ env: { NOEVIA_FEATURE_PLANNER_REVIEW: 'true' }, log: () => {} }).enabled('plannerReview'), true);
});

test('plannerReview: astraReview is accepted as an alias on input, and only the new key is written', () => {
  const store = memoryStore();
  const features = createFeatures({ env: {}, store, log: () => {} });
  assert.equal(features.resolve('astraReview'), 'plannerReview');
  assert.equal(features.resolve('previews'), 'previews');
  features.set('astraReview', true, 'admin1');
  assert.equal(features.enabled('plannerReview'), true);
  assert.equal(features.enabled('astraReview'), true);
  assert.equal(store.m.get('feature:plannerReview'), 'true');
  assert.equal(store.m.has('feature:astraReview'), false);
  assert.equal(Object.keys(features.flags()).includes('astraReview'), false, 'flags use the new name only');
});

test('#705: the Code pipeline and merge flags are off by default and need the code sandbox', () => {
  const none = createFeatures({ env: { NOEVIA_FEATURE_CODE_PIPELINE: 'true', NOEVIA_FEATURE_CODE_MERGE: 'true' } });
  assert.equal(none.enabled('codePipeline'), false, 'unavailable without the sandbox wins over the env pin');
  assert.equal(none.enabled('codeMerge'), false);
  const sandbox = { CODE_HARNESS_ENDPOINT: 'code-sandbox:7700' };
  assert.equal(createFeatures({ env: sandbox }).enabled('codePipeline'), false, 'off by default');
  assert.equal(createFeatures({ env: { ...sandbox, NOEVIA_FEATURE_CODE_PIPELINE: 'true' } }).enabled('codePipeline'), true);
  assert.equal(createFeatures({ env: { ...sandbox, NOEVIA_FEATURE_CODE_MERGE: 'true' } }).enabled('codeMerge'), true);
  assert.equal(createFeatures({ env: { NOEVIA_FEATURE_CONSTRAINED_PLAN_DECODING: 'true' } }).enabled('constrainedPlanDecoding'), true);
});

const nativeStatusEnv = () => ({ NOEVIA_FRONT: 'rust', NOEVIA_RUST_AUTH: '1', NOEVIA_RUST_AUTH_CONFIRMED: '1', NOEVIA_RUST_CHATGPT_STATUS: '1', NOEVIA_RUST_CHATGPT_STATUS_CONFIRMED: '1' });

test('native ChatGPT status: every ownership selector is exact and confirmed', () => {
  const { rustChatgptStatusOwned } = require('./features.cjs');
  const baseline = nativeStatusEnv();
  for (const key of Object.keys(baseline)) {
    for (const value of [undefined, '', '0', 'true', 'yes', ' 1', '1 ', 'Rust', ' rust', 'rust ', 1]) {
      assert.equal(rustChatgptStatusOwned({ ...baseline, [key]: value }), false, 'M6_STATUS_POLICY:confirmed_owner');
    }
  }
  // Finite property: all 32 subsets, only the complete confirmed owner may hand off.
  const keys = Object.keys(baseline);
  for (let mask = 0; mask < 32; mask++) {
    const env = Object.fromEntries(keys.map((key, i) => [key, mask & (1 << i) ? baseline[key] : '0']));
    assert.equal(rustChatgptStatusOwned(env), mask === 31, 'M6_STATUS_POLICY:confirmed_owner');
  }
});

test('native ChatGPT status: typed SQL projection affects only the two product keys', () => {
  const Database = require('better-sqlite3');
  const { settingsStore } = require('./features.cjs');
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT)');
    const store = settingsStore(db);
    db.prepare('INSERT INTO settings VALUES(?,?)').run('feature:chatgptOAuth', Buffer.from('true'));
    assert.equal(store.get('feature:chatgptOAuth') === null, true, 'M6_STATUS_POLICY:typed_projection');
    for (const key of ['feature:chatgptOAuth', 'feature:routingModes']) {
      for (const raw of [Buffer.from('true'), Buffer.from('false'), null, 1, 0, 'TRUE', ' true ', '1', '', 'true', 'false']) {
        db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run(key, raw);
        const expected = raw === 'true' || raw === 'false' ? raw : null;
        assert.equal(store.get(key), expected);
      }
      db.prepare('DELETE FROM settings WHERE key=?').run(key);
      assert.equal(store.get(key), undefined);
    }
    const opaque = Buffer.from('true');
    store.set('other', opaque);
    assert.deepEqual(store.get('other'), opaque, 'unrelated settings retain their original projection');
  } finally { db.close(); }
});

test('native ChatGPT status: refreshed cache follows typed truth on all read surfaces', () => {
  const store = memoryStore({ 'feature:chatgptOAuth': 'true', 'feature:previews': 'false' });
  const registry = { chatgptOAuth: REGISTRY.chatgptOAuth, previews: REGISTRY.previews };
  const features = createFeatures({ env: nativeStatusEnv(), store, registry });
  store.set('feature:chatgptOAuth', 'false');
  assert.equal(features.enabled('chatgptOAuth'), false, 'M6_STATUS_POLICY:refreshed_cache');
  // Construct before every change so each API independently has to refresh its own stale cache.
  for (const read of [f => f.enabled('chatgptOAuth'), f => f.flags().chatgptOAuth, f => f.describe().find(row => row.name === 'chatgptOAuth').enabled]) {
    for (const raw of ['true', 'false', undefined, null, 1, true, Buffer.from('true'), 'TRUE', ' true ', '1', '']) {
      store.set('feature:chatgptOAuth', raw === 'true' ? 'false' : 'true');
      store.set('feature:previews', 'false');
      const f = createFeatures({ env: nativeStatusEnv(), store, registry });
      if (raw === undefined) store.m.delete('feature:chatgptOAuth'); else store.set('feature:chatgptOAuth', raw);
      store.set('feature:previews', 'true');
      assert.equal(read(f), raw === 'true');
      assert.equal(f.enabled('previews'), false, 'refresh does not broaden to other flags');
      const row = f.describe().find(row => row.name === 'chatgptOAuth');
      assert.equal(row.source, raw === 'true' || raw === 'false' ? 'admin' : 'default');
      assert.equal(row.locked, false);
    }
  }
  for (const env of [{}, { ...nativeStatusEnv(), NOEVIA_FRONT: 'node' }, { ...nativeStatusEnv(), NOEVIA_RUST_CHATGPT_STATUS_CONFIRMED: '0' }]) {
    store.set('feature:chatgptOAuth', 'true');
    const f = createFeatures({ env, store, registry });
    store.set('feature:chatgptOAuth', 'false');
    assert.equal(f.enabled('chatgptOAuth'), true, 'unconfirmed Node ownership retains the existing cache');
  }
});

test('native ChatGPT status: env locks and read failures cannot resurrect stale truth', () => {
  const registry = { chatgptOAuth: REGISTRY.chatgptOAuth };
  for (const [raw, expected] of [[' TRUE ', true], ['On', true], ['yes', true], ['1', true], [' OFF ', false], ['No', false], ['false', false], ['0', false]]) {
    let reads = 0;
    const f = createFeatures({ env: { ...nativeStatusEnv(), NOEVIA_FEATURE_CHATGPT_OAUTH: raw }, registry, store: { get() { reads++; throw new Error('synthetic read'); }, set() { throw new Error('unexpected write'); } } });
    assert.equal(f.enabled('chatgptOAuth'), expected);
    assert.equal(f.flags().chatgptOAuth, expected);
    assert.deepEqual([f.describe()[0].source, f.describe()[0].locked], ['env', true]);
    assert.throws(() => f.set('chatgptOAuth', !expected, 'synthetic'), e => e.status === 409);
    assert.equal(reads, 0, 'env override precedes store access');
  }
  assert.throws(() => createFeatures({ env: { ...nativeStatusEnv(), NOEVIA_FEATURE_CHATGPT_OAUTH: 'invalid' }, registry }));
  const store = memoryStore({ 'feature:chatgptOAuth': 'true' });
  const f = createFeatures({ env: { ...nativeStatusEnv(), NOEVIA_FEATURE_CHATGPT_OAUTH: ' ' }, store, registry });
  const save = store.set;
  store.set = (key, value) => { save(key, value); throw new Error('synthetic committed write then throw'); };
  assert.throws(() => f.set('chatgptOAuth', false, 'synthetic'), /committed write/);
  assert.equal(f.enabled('chatgptOAuth'), false, 'committed false survives failed cache update');
  assert.equal(f.flags().chatgptOAuth, false);
  assert.equal(f.describe()[0].enabled, false);
  assert.throws(() => f.set('chatgptOAuth', true, 'synthetic'), /committed write/);
  assert.equal(f.enabled('chatgptOAuth'), true);
  store.get = () => { throw new Error('synthetic store unavailable'); };
  for (const read of [() => f.enabled('chatgptOAuth'), () => f.flags(), () => f.describe()]) {
    assert.throws(read, e => e.status === 503 && e.message === 'ChatGPT feature settings are unavailable.');
  }
});
