'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const owner = require('./rust-model-folder-sync.cjs');

const index = fs.readFileSync(path.join(__dirname, 'index.cjs'), 'utf8');

test('the owner marker names the capability the front carries, and cannot be changed', () => {
  assert.equal(owner.RUST_MODEL_FOLDER_SYNC_OWNED, 'rust-model-folder-sync-v1');
  assert.ok(Object.isFrozen(owner));
  assert.throws(() => { 'use strict'; owner.RUST_MODEL_FOLDER_SYNC_OWNED = 'x'; }, TypeError);
});

test('the Node worker and its wiring are gone; index.cjs names the owner module for the supervisor and release pairing', () => {
  assert.equal(fs.existsSync(path.join(__dirname, 'model-folder-sync.cjs')), false);
  assert.equal(fs.existsSync(path.join(__dirname, 'model-folder-sync.test.cjs')), false);
  assert.doesNotMatch(index, /(?<!rust-)model-folder-sync\.cjs|createFolderSync|folderSync/);
  // Exactly the statement the supervisor and assemble-release.sh look for.
  assert.equal(index.split("require('./rust-model-folder-sync.cjs')").length - 1, 1);
  assert.doesNotMatch(index, /safe-defaults/);
});

test('nothing in the Core tree starts a folder scan on its own any more', () => {
  const offenders = [];
  for (const name of fs.readdirSync(__dirname)) {
    if (!name.endsWith('.cjs') || name.endsWith('.test.cjs') || name === 'rust-model-folder-sync.cjs') continue;
    if (/safe-defaults/.test(fs.readFileSync(path.join(__dirname, name), 'utf8'))) offenders.push(name);
  }
  assert.deepEqual(offenders, []);
});

// The sync's part of boot, executed: with a configured loader nothing reads the manager or the engine.
test('a configured loader at boot starts no scan, registration or reload from this process', async () => {
  const from = index.indexOf('// The models folder sync');
  const to = index.indexOf('// noevia#2115: leases still held', from);
  assert.ok(from >= 0 && to > from);
  const calls = [];
  const context = { process: { env: { MODEL_LOADER_URL: 'http://synthetic-loader.invalid' } }, require: (m) => { calls.push(['require', m]); return require(m); } };
  vm.runInNewContext(index.slice(from, to), context, { timeout: 1000 });
  assert.deepEqual(calls, [['require', './rust-model-folder-sync.cjs']]);
});
