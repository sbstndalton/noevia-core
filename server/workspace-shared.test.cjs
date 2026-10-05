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
  admin.saveShared('shared-y'); // by id: the view no longer holds it, so it is removed (#785)
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

// ── #782: an unreadable stored key never takes the workspace down ───────────

const OTHER_KEY = Buffer.alloc(32, 7);
function cipherFromAnotherKey(root, plain) {
  // A value sealed under a key this server does not have (secrets.key restored without its
  // rows, or secrets.key.previous removed after a rotation that left failures).
  const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-other-key-'));
  fs.writeFileSync(path.join(otherDir, 'secrets.key'), OTHER_KEY, { mode: 0o600 });
  const value = createSecretStore(otherDir).encrypt(plain);
  fs.rmSync(otherDir, { recursive: true, force: true });
  return value;
}

test('#782: a shared provider key no key opens leaves get() working and flags the row for re-entry', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-shared-providers-'));
  const sharedFile = path.join(root, 'shared-providers.json');
  const secrets = createSecretStore(root);
  const unreadable = cipherFromAnotherKey(root, 'sk-synthetic-lost');
  assert.throws(() => secrets.decrypt(unreadable), 'the fixture really is unreadable here');
  fs.writeFileSync(sharedFile, JSON.stringify({ providers: [
    { id: 'shared-lost', label: 'Lost', baseUrl: 'https://lost.test/v1', apiKey: unreadable, shared: true },
    { id: 'shared-ok', label: 'Fine', baseUrl: 'https://ok.test/v1', apiKey: secrets.encrypt('sk-synthetic-ok'), shared: true },
  ] }));
  const store = createWorkspaceStore(root, { id: 'default', label: 'Default', baseUrl: 'http://localhost', apiKey: '' }, secrets);

  const admin = store.get(ADMIN_ID);
  const lost = admin.providers.find((p) => p.id === 'shared-lost');
  assert.equal(lost.apiKey, '');
  assert.equal(lost.keyUnreadable, true);
  assert.equal(admin.providers.find((p) => p.id === 'shared-ok').apiKey, 'sk-synthetic-ok', 'other rows still decrypt');
  assert.ok(!JSON.stringify(admin.providers).includes(unreadable), 'the ciphertext is not on the enumerable row');

  // Saving another shared provider writes the unreadable key back exactly as it was, so
  // restoring the right key later still recovers it.
  admin.providers.push({ id: 'shared-new', label: 'New', baseUrl: 'https://new.test/v1', apiKey: 'sk-synthetic-new', shared: true });
  admin.saveShared('shared-new');
  const onDisk = JSON.parse(fs.readFileSync(sharedFile, 'utf8')).providers;
  const lostOnDisk = onDisk.find((p) => p.id === 'shared-lost');
  assert.equal(lostOnDisk.apiKey, unreadable);
  assert.equal('keyUnreadable' in lostOnDisk, false, 'the flag is never persisted');

  // Entering a new key replaces it.
  const view = store.get(ADMIN_ID);
  const row = view.providers.find((p) => p.id === 'shared-lost');
  row.apiKey = 'sk-synthetic-reentered'; delete row.keyUnreadable;
  view.saveShared('shared-lost');
  const again = store.get(USER_B_ID).providers.find((p) => p.id === 'shared-lost');
  assert.equal(again.apiKey, 'sk-synthetic-reentered');
  assert.equal(again.keyUnreadable, undefined);

  fs.rmSync(root, { recursive: true, force: true });
});

test('#782: a private provider key no key opens loads with an empty key and survives an unrelated save', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-shared-providers-'));
  const secrets = createSecretStore(root);
  const unreadable = cipherFromAnotherKey(root, 'sk-synthetic-private');
  const dir = path.join(root, 'users', USER_B_ID);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'providers.json'), JSON.stringify({ providers: [
    { id: 'mine-lost', label: 'Mine', baseUrl: 'https://mine.test/v1', apiKey: unreadable },
  ] }));
  const store = createWorkspaceStore(root, { id: 'default', label: 'Default', baseUrl: 'http://localhost', apiKey: '' }, secrets);

  const user = store.get(USER_B_ID);
  const row = user.providers.find((p) => p.id === 'mine-lost');
  assert.deepEqual([row.apiKey, row.keyUnreadable], ['', true]);
  user.providers.push({ id: 'mine-new', label: 'New', baseUrl: 'https://new.test/v1', apiKey: 'sk-synthetic-new' });
  user.saveProviders();
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'providers.json'), 'utf8')).providers;
  assert.equal(onDisk.find((p) => p.id === 'mine-lost').apiKey, unreadable);
  assert.equal(secrets.decrypt(onDisk.find((p) => p.id === 'mine-new').apiKey), 'sk-synthetic-new');

  fs.rmSync(root, { recursive: true, force: true });
});

// ── #785: a shared save applies its change by id onto a fresh read ──────────

test('#785: interleaved shared saves from two admins keep both providers', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-shared-providers-'));
  const sharedFile = path.join(root, 'shared-providers.json');
  const secrets = createSecretStore(root);
  const store = createWorkspaceStore(root, { id: 'default', label: 'Default', baseUrl: 'http://localhost', apiKey: '' }, secrets);
  const ADMIN_TWO = 'cccccccc-3333-4333-8333-333333333333';

  // Both requests merge their views first (as the router does at request start)...
  const viewA = store.get(ADMIN_ID).providers;
  const adminA = store.get(ADMIN_ID);
  const adminB = store.get(ADMIN_TWO);
  assert.equal(viewA.length, 1);
  // ...then B saves while A is still waiting for its body...
  adminB.providers.push({ id: 'shared-b', label: 'B', baseUrl: 'https://b.test/v1', apiKey: 'sk-synthetic-b', shared: true });
  adminB.saveShared('shared-b');
  // ...and A saves from its stale view, which never saw B's provider.
  adminA.providers.push({ id: 'shared-a', label: 'A', baseUrl: 'https://a.test/v1', apiKey: 'sk-synthetic-a', shared: true });
  assert.ok(!adminA.providers.some((p) => p.id === 'shared-b'), 'A really holds a stale view');
  adminA.saveShared('shared-a');

  const ids = JSON.parse(fs.readFileSync(sharedFile, 'utf8')).providers.map((p) => p.id).sort();
  assert.deepEqual(ids, ['shared-a', 'shared-b']);

  // An edit from a stale view changes only its own row.
  const staleA = store.get(ADMIN_ID);
  const editB = store.get(ADMIN_TWO);
  editB.providers.find((p) => p.id === 'shared-b').label = 'B renamed';
  editB.saveShared('shared-b');
  staleA.providers.find((p) => p.id === 'shared-a').label = 'A renamed';
  staleA.saveShared('shared-a');
  const labels = Object.fromEntries(JSON.parse(fs.readFileSync(sharedFile, 'utf8')).providers.map((p) => [p.id, p.label]));
  assert.deepEqual(labels, { 'shared-a': 'A renamed', 'shared-b': 'B renamed' });

  // The no-argument form upserts and never removes a row another admin added.
  const noArg = store.get(ADMIN_ID);
  noArg.providers = noArg.providers.filter((p) => p.id !== 'shared-b');
  noArg.saveShared();
  assert.ok(JSON.parse(fs.readFileSync(sharedFile, 'utf8')).providers.some((p) => p.id === 'shared-b'));

  fs.rmSync(root, { recursive: true, force: true });
});
