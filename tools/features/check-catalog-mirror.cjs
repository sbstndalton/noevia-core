#!/usr/bin/env node
'use strict';
// Compares the canonical Rust feature contract (noevia-rs, at the commit server/feature-catalog.lock.json
// pins) with what this Core actually runs: the production read-only features
// (server/features.cjs createReadOnlyFeatures, behind a stand-in of the native runtime lease).
//
//   node tools/features/check-catalog-mirror.cjs <core checkout> <canonical noevia-rs checkout>
//
// Node no longer writes features, so the fixture's write transitions are not replayed through Node:
// each is reproduced the way production meets it, the native owner changes the settings row and Node
// reads the result. Synthetic rows and environments only; no model, network or Diary.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const [coreArg, canonicalArg] = process.argv.slice(2);
if (!coreArg || !canonicalArg) throw new Error('usage: node check-catalog-mirror.cjs <core checkout> <canonical noevia-rs checkout>');
const core = path.resolve(coreArg), canonical = path.resolve(canonicalArg);
const catalog = JSON.parse(fs.readFileSync(path.join(canonical, 'contracts/features/catalog.json'), 'utf8'));
const fixture = JSON.parse(fs.readFileSync(path.join(canonical, 'crates/server-features/tests/fixtures/core-feature-eval-v2.json'), 'utf8'));
const Database = require(require.resolve('better-sqlite3', { paths: [path.join(core, 'server')] }));
const { REGISTRY, createReadOnlyFeatures } = require(path.join(core, 'server/features.cjs'));

// Static facts: the canonical catalog and the fixture's definitions against the production registry.
assert.equal(catalog.version, 1);
assert.deepEqual(Object.keys(REGISTRY), fixture.names);
assert.deepEqual(catalog.features.map(row => row.id), fixture.names);
const AVAILABILITY = {
  stepSupervision: 'decisionChoice', systemOneRouting: 'systemOne', toolGate: 'decisionChoice', browserExecutor: 'browser',
  codePipeline: 'codeSandbox', codeMerge: 'codeSandbox', chatFraming: 'decisionChoice', framingReasoner: 'decisionChoice',
  nativeClientAuth: 'trustProxy',
};
const dynamic = spec => typeof spec.unavailable === 'function';
for (const row of catalog.features) {
  const spec = REGISTRY[row.id];
  assert.deepEqual({
    id: row.id, env: spec.env, default: spec.default === true, experimental: spec.experimental === true,
    restart: spec.restart === true, legacy: spec.legacy?.name ?? null, label: spec.label, description: spec.description,
    availability: AVAILABILITY[row.id] ?? 'none',
  }, { id: row.id, env: row.env, default: row.default, experimental: row.experimental, restart: row.restart,
    legacy: row.legacy, label: row.label, description: row.description, availability: row.availability });
  assert.equal(dynamic(spec), row.availability !== 'none', row.id);
}
for (const row of fixture.definitions) {
  const spec = REGISTRY[row.name];
  assert.deepEqual({
    name: row.name, env: spec.env, setting: 'feature:' + row.name, default: spec.default === true,
    experimental: spec.experimental === true, restart: spec.restart === true, legacy: spec.legacy?.name ?? null,
    label: spec.label, description: spec.description, dynamicAvailability: dynamic(spec),
  }, row);
}

// Browser availability is probed from the installed playwright; the check gives it a synthetic one.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-catalog-mirror-'));
const chromium = path.join(scratch, 'chromium');
fs.writeFileSync(chromium, '');
const fake = path.join(scratch, 'playwright.cjs');
fs.writeFileSync(fake, `module.exports = { chromium: { executablePath: () => ${JSON.stringify(chromium)} } };`);
let browser = false;
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request !== 'playwright') return resolveFilename.call(this, request, ...rest);
  if (!browser) throw Object.assign(new Error('synthetic: playwright is not installed'), { code: 'MODULE_NOT_FOUND' });
  return fake;
};

const DYNAMIC = ['stepSupervision', 'toolGate', 'systemOneRouting', 'chatFraming', 'framingReasoner'];
const db = new Database(':memory:');
db.exec('CREATE TABLE settings(key TEXT PRIMARY KEY, value)');
const native = { read: action => action(db) }; // the stand-in for the native runtime lease: reads see this db
const put = (key, value) => db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key, typeof value === 'boolean' ? Number(value) : value);
function open(name, { envRaw, available }) {
  const env = { TRUST_PROXY: available ? 'true' : 'false' };
  if (available) env.CODE_HARNESS_ENDPOINT = 'http://synthetic-code-sandbox:1';
  if (envRaw !== null) env[REGISTRY[name].env] = envRaw;
  browser = available;
  const reason = available ? null : 'synthetic unavailable';
  return {
    env,
    features: createReadOnlyFeatures({
      db, runtime: () => native, env,
      availability: Object.fromEntries(DYNAMIC.map(id => [id, () => reason])),
    }).features,
  };
}
const describe = (features, name) => {
  const row = features.describe().find(candidate => candidate.name === name);
  return {
    value: row.enabled, source: row.source, locked: row.locked, available: row.unavailable == null,
    enabled: features.enabled(name), flag: features.flags()[name], pendingRestart: row.pendingRestart,
  };
};

try {
  let cases = 0, transitions = 0;
  for (const c of fixture.cases) {
    db.exec('DELETE FROM settings');
    if (c.stored !== null) put('feature:' + c.name, c.stored);
    let actual;
    try { actual = describe(open(c.name, c).features, c.name); } catch (error) { actual = { error: error.message }; }
    assert.deepEqual(actual, c.expected, JSON.stringify(c));
    cases++;
  }
  for (const c of fixture.transitions) {
    db.exec('DELETE FROM settings');
    put('feature:' + c.name, String(c.boot));
    const { features } = open(c.name, { envRaw: null, available: true });
    // The native owner saves the admin's choice; Node only reads it (restart features keep their boot value).
    put('feature:' + c.name, String(c.next));
    assert.deepEqual(describe(features, c.name), c.expected, JSON.stringify(c));
    transitions++;
  }
  // The retired name: Node resolves it and reads through it, and writes and migrates nothing.
  db.exec('DELETE FROM settings');
  put('feature:astraReview', 'true');
  const { features } = open('plannerReview', { envRaw: null, available: true });
  assert.equal(features.resolve('astraReview'), fixture.legacy.resolved);
  assert.deepEqual(describe(features, 'plannerReview'), fixture.legacy.before);
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='feature:plannerReview'").get(), undefined, 'Node migrates nothing; the native owner does');
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='feature:astraReview'").get().value, fixture.legacy.original);
  put('feature:plannerReview', 'false'); // what the native owner saves for set('astraReview', false)
  assert.deepEqual(describe(features, 'plannerReview'), fixture.legacy.after);
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='feature:plannerReview'").get().value, fixture.legacy.updated);
  // The facade is read-only: no writer is reachable from it.
  for (const name of ['set', 'delete', 'reset', 'migrate']) assert.equal(features[name], undefined, name);
  console.log(`feature catalog mirror: ${catalog.features.length} definitions, ${cases} cases, ${transitions} native transitions, legacy alias`);
} finally {
  Module._resolveFilename = resolveFilename;
  db.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}
