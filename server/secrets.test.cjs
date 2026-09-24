'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSecretStore } = require('./secrets.cjs');

test('directory mode stays restricted after creation', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-dir-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createSecretStore(path.join(root, 'nested', 'dir'));
  assert.equal(fs.statSync(path.dirname(store.keyFile)).mode & 0o777, 0o700);
});

test('a fresh nested state directory starts and reuses its encryption key', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-fresh-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = path.join(root, 'new', 'state');
  const store = createSecretStore(state);
  const ciphertext = store.encrypt('test secret');
  assert.equal(createSecretStore(state).decrypt(ciphertext), 'test secret');
  assert.equal(fs.statSync(store.keyFile).mode & 0o777, 0o600);
});

test('v1 still decrypts, v2 binds to the account, and ciphertext-looking input is encrypted', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-aad-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createSecretStore(root);
  const v1 = store.encrypt('legacy');
  assert.match(v1, /^enc:v1:/);
  assert.equal(store.decrypt(v1), 'legacy');
  assert.equal(store.decrypt(v1, 'any-user'), 'legacy');
  const v2 = store.encrypt('bound', 'user-a');
  assert.match(v2, /^enc:v2:/);
  assert.equal(store.decrypt(v2, 'user-a'), 'bound');
  assert.throws(() => store.decrypt(v2, 'user-b'));
  assert.throws(() => store.decrypt(v2));
  const replayed = store.encrypt(v2, 'user-b');
  assert.notEqual(replayed, v2);
  assert.equal(store.decrypt(replayed, 'user-b'), v2);
  assert.notEqual(store.encrypt(v1), v1);
  assert.equal(store.encrypt(''), '');
});
