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
