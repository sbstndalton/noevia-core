'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadCatalog } = require('./feature-catalog.cjs');

test('the generated mirror is the ordered production registry metadata', () => {
  const catalog = loadCatalog();
  const { REGISTRY } = require('./features.cjs');
  assert.equal(catalog.version, 1);
  assert.equal(catalog.features.length, 23);
  assert.deepEqual(Object.keys(REGISTRY), catalog.features.map(row => row.id));
  for (const row of catalog.features) {
    const spec = REGISTRY[row.id];
    assert.equal(spec.env, row.env);
    assert.equal(spec.default === true, row.default);
    assert.equal(spec.experimental === true, row.experimental);
    assert.equal(spec.restart === true, row.restart);
    assert.equal(spec.legacy?.name ?? null, row.legacy);
    assert.equal(spec.label, row.label);
    assert.equal(spec.description, row.description);
    assert.equal(typeof spec.unavailable === 'function', row.availability !== 'none');
  }
});

test('a changed mirror refuses before any feature can be enabled', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-feature-catalog-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const mirror = path.join(dir, 'catalog.json');
  const lockFile = path.join(dir, 'lock.json');
  fs.copyFileSync(path.join(__dirname, 'feature-catalog.json'), mirror);
  fs.copyFileSync(path.join(__dirname, 'feature-catalog.lock.json'), lockFile);
  assert.equal(loadCatalog({ mirror, lockFile }).features.length, 23);
  fs.appendFileSync(mirror, ' ');
  assert.throws(() => loadCatalog({ mirror, lockFile }), /does not match its canonical lock/);
  fs.copyFileSync(path.join(__dirname, 'feature-catalog.json'), mirror);
  const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  lock.canonicalRef = 'not-a-commit';
  fs.writeFileSync(lockFile, JSON.stringify(lock));
  assert.throws(() => loadCatalog({ mirror, lockFile }), /does not match its canonical lock/);
});
