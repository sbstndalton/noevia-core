'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createWorkspaceStore } = require('./workspace.cjs');
const { createSecretStore } = require('./secrets.cjs');

const ADMIN_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const USER_B_ID = 'bbbbbbbb-2222-4222-8222-222222222222';

test('a stale cached workspace cannot erase shared providers when saving private ones', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-shared-providers-'));
  const sharedFile = path.join(root, 'shared-providers.json');
  const secrets = createSecretStore(root);
  const store = createWorkspaceStore(root, { id: 'default', label: 'Default', baseUrl: 'http://localhost', apiKey: '' }, secrets);

  // 1. User B's workspace gets cached BEFORE the shared provider exists.
  const userB = store.get(USER_B_ID);
  userB.providers.push({ id: 'private-b', label: 'B private', baseUrl: 'https://b.test/v1', apiKey: 'b-key' });
  userB.saveProviders();

  // 2. Admin adds shared provider X afterwards.
  const admin = store.get(ADMIN_ID);
  admin.providers.push({ id: 'shared-x', label: 'Shared X', baseUrl: 'https://x.test/v1', apiKey: 'x-key', shared: true });
  admin.saveShared();
  assert.match(fs.readFileSync(sharedFile, 'utf8'), /shared-x/);

  // 3. User B saves an unrelated private-provider change from their stale,
  //    cached workspace. This must NOT rewrite the shared file.
  userB.providers = userB.providers.filter((p) => p.id !== 'private-b');
  userB.saveProviders();

  const sharedAfter = JSON.parse(fs.readFileSync(sharedFile, 'utf8')).providers.map((p) => p.id);
  assert.ok(sharedAfter.includes('shared-x'), 'shared provider X must survive user B private save');

  // 4. B's next read picks up X through the re-merged view even though the
  //    workspace object itself is cached.
  const userBAgain = store.get(USER_B_ID);
  assert.ok(userBAgain.providers.some((p) => p.id === 'shared-x'));

  fs.rmSync(root, { recursive: true, force: true });
});

test('deleting a shared provider propagates to other users without restart', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-shared-providers-'));
  const sharedFile = path.join(root, 'shared-providers.json');
  const secrets = createSecretStore(root);
  const store = createWorkspaceStore(root, { id: 'default', label: 'Default', baseUrl: 'http://localhost', apiKey: '' }, secrets);

  // Cache user B first.
  const userB = store.get(USER_B_ID);
  assert.ok(userB);

  // Admin adds then removes shared provider X.
  const admin = store.get(ADMIN_ID);
  admin.providers.push({ id: 'shared-y', label: 'Shared Y', baseUrl: 'https://y.test/v1', apiKey: '', shared: true });
  admin.saveShared();
  admin.providers = admin.providers.filter((p) => p.id !== 'shared-y');
  admin.saveShared();
  assert.doesNotMatch(fs.readFileSync(sharedFile, 'utf8'), /shared-y/);

  // B sees the deletion on their next read despite the cache.
  const userBAgain = store.get(USER_B_ID);
  assert.ok(!userBAgain.providers.some((p) => p.id === 'shared-y'));

  fs.rmSync(root, { recursive: true, force: true });
});

test('removing a shared provider never writes the padded default row to disk', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-shared-providers-'));
  const sharedFile = path.join(root, 'shared-providers.json');
  const secrets = createSecretStore(root);
  const defaultProvider = { id: 'default', label: 'Default', baseUrl: 'http://localhost', apiKey: 'env-secret' };
  const store = createWorkspaceStore(root, defaultProvider, secrets);

  const admin = store.get(ADMIN_ID);
  admin.providers.push({ id: 'shared-z', label: 'Shared Z', baseUrl: 'https://z.test/v1', apiKey: '', shared: true });
  admin.saveShared();

  // removeProvider() (not saveShared()) is the path under test: it must
  // exclude the built-in default row the same way saveShared() does.
  assert.equal(admin.removeProvider('shared-z'), true);

  const raw = fs.readFileSync(sharedFile, 'utf8');
  assert.doesNotMatch(raw, /shared-z/);
  assert.doesNotMatch(raw, /"default"/, 'the built-in default row must never be persisted to shared-providers.json');
  assert.doesNotMatch(raw, /env-secret/, 'the env-sourced default key must never be persisted');

  // The default is still exposed to callers, sourced from env, not disk.
  const userAgain = store.get(USER_B_ID);
  assert.ok(userAgain.providers.some((p) => p.id === 'default' && p.apiKey === 'env-secret'));

  fs.rmSync(root, { recursive: true, force: true });
});

test('loadShared prefers env-derived default values over a stale row left in the file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-shared-providers-'));
  const sharedFile = path.join(root, 'shared-providers.json');
  const secrets = createSecretStore(root);

  // Simulate a file written by a pre-fix build: it contains a "default" row
  // with a stale label/key that must not shadow the current env config.
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(sharedFile, JSON.stringify({
    providers: [{ id: 'default', label: 'Stale Label', baseUrl: 'http://stale', apiKey: secrets.encrypt('stale-key'), shared: true }],
  }));

  const defaultProvider = { id: 'default', label: 'Fresh Label', baseUrl: 'http://fresh', apiKey: 'fresh-env-key' };
  const store = createWorkspaceStore(root, defaultProvider, secrets);

  const user = store.get(USER_B_ID);
  const seenDefault = user.providers.find((p) => p.id === 'default');
  assert.equal(seenDefault.label, 'Fresh Label');
  assert.equal(seenDefault.apiKey, 'fresh-env-key');

  // Any write path (saveShared/removeProvider) drops the stale row going forward.
  user.providers.push({ id: 'shared-drop-trigger', label: 'Trigger', baseUrl: 'https://t.test', apiKey: '', shared: true });
  user.saveShared();
  const raw = fs.readFileSync(sharedFile, 'utf8');
  assert.doesNotMatch(raw, /Stale Label/);
  assert.doesNotMatch(raw, /stale-key/);

  fs.rmSync(root, { recursive: true, force: true });
});
