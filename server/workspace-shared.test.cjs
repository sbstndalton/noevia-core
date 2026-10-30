'use strict';
// The provider rows as a workspace reads them (sbstndalton/noevia#2190 round 6). The Rust front is
// the only writer of users/<id>/providers.json and shared-providers.json (noevia-rs
// provider_routes.rs, tested there: the locked read-modify-write, the shared rule, the keys); these
// tests play the front by writing the files, and check that Node keeps no copy: the private rows are
// re-read by the file's change signal on every get(), failing closed to none; the shared rows on
// every access; an unreadable key never takes a workspace down; and the one write Node still makes,
// sealing a plaintext key, goes through the project store.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createWorkspaceStore } = require('./workspace.cjs');
const { createStubStore } = require('../tests/server/project-store-stub.cjs');
const { createSecretStore } = require('./secrets.cjs');

const ADMIN_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const USER_B_ID = 'bbbbbbbb-2222-4222-8222-222222222222';
const DEFAULT = { id: 'default', label: 'Default', baseUrl: 'http://localhost', apiKey: '' };

function fixture(t, defaultProvider = DEFAULT) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-shared-providers-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const secrets = createSecretStore(root);
  const projectStore = createStubStore(root);
  const store = createWorkspaceStore(root, defaultProvider, secrets, { projectStore });
  const files = {
    shared: path.join(root, 'shared-providers.json'),
    private: (id) => path.join(root, 'users', id, 'providers.json'),
  };
  /** What the front writes: an atomic rename, so the file's inode changes. */
  const write = (file, rows) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ providers: rows }, null, 2));
    fs.renameSync(`${file}.tmp`, file);
  };
  return { root, secrets, projectStore, store, files, write };
}

test('a cached workspace sees the front\'s writes of its private rows on the next get(), with no copy kept', (t) => {
  const f = fixture(t);
  const ws = f.store.get(USER_B_ID);
  assert.deepEqual(ws.privateProviders, []);
  f.write(f.files.private(USER_B_ID), [{ id: 'mine', label: 'Mine', baseUrl: 'https://b.test/v1', apiKey: f.secrets.encrypt('b-key'), shared: false }]);
  const again = f.store.get(USER_B_ID);
  assert.equal(again, ws, 'the workspace itself is cached');
  const mine = again.providers.find((p) => p.id === 'mine');
  assert.equal(mine.apiKey, 'b-key', 'the key is opened');
  // Edited and removed by the front: seen at once.
  f.write(f.files.private(USER_B_ID), [{ id: 'mine', label: 'Renamed', baseUrl: 'https://b.test/v1', apiKey: '', shared: false }]);
  assert.equal(f.store.get(USER_B_ID).providers.find((p) => p.id === 'mine').label, 'Renamed');
  f.write(f.files.private(USER_B_ID), []);
  assert.ok(!f.store.get(USER_B_ID).providers.some((p) => p.id === 'mine'));
  // An unchanged file is not parsed again.
  const before = f.store.get(USER_B_ID).privateProviders;
  assert.equal(f.store.get(USER_B_ID).privateProviders, before);
});

test('the workspace has no provider writer: the front is the only one', (t) => {
  const f = fixture(t);
  const ws = f.store.get(ADMIN_ID);
  for (const name of ['saveProviders', 'saveShared', 'removeProvider']) assert.equal(ws[name], undefined, name);
  // A row pushed onto the merged view is not persisted anywhere.
  ws.providers.push({ id: 'ghost', label: 'Ghost', baseUrl: 'https://g.test', apiKey: 'k' });
  assert.equal(fs.existsSync(f.files.private(ADMIN_ID)), false);
  assert.ok(!f.store.get(ADMIN_ID).providers.some((p) => p.id === 'ghost'), 'the next get() rebuilds the view from the files');
});

test('the shared rows are read again on every access, and the default row is the environment\'s', (t) => {
  const f = fixture(t, { id: 'default', label: 'Fresh Label', baseUrl: 'http://fresh', apiKey: 'fresh-env-key' });
  const userB = f.store.get(USER_B_ID);
  assert.ok(!userB.providers.some((p) => p.id === 'shared-x'));
  // The front adds a shared row (and a stale default row from a pre-fix build is in the file).
  f.write(f.files.shared, [
    { id: 'default', label: 'Stale Label', baseUrl: 'http://stale', apiKey: f.secrets.encrypt('stale-key'), shared: true },
    { id: 'shared-x', label: 'Shared X', baseUrl: 'https://x.test/v1', apiKey: f.secrets.encrypt('x-key'), shared: true },
  ]);
  const seen = f.store.get(USER_B_ID).providers;
  assert.equal(seen.find((p) => p.id === 'shared-x').apiKey, 'x-key');
  const seenDefault = seen.find((p) => p.id === 'default');
  assert.deepEqual([seenDefault.label, seenDefault.apiKey], ['Fresh Label', 'fresh-env-key']);
  assert.equal(seen.filter((p) => p.id === 'default').length, 1);
  // Removed by the front: gone for the account whose workspace is cached, with no restart.
  f.write(f.files.shared, []);
  assert.ok(!f.store.get(USER_B_ID).providers.some((p) => p.id === 'shared-x'));
});

test('a legacy `lemonade` row is the default, the first row of an id wins, shared-flagged private rows are not shown', (t) => {
  const f = fixture(t);
  f.write(f.files.private(USER_B_ID), [
    { id: 'lemonade', label: 'Old', baseUrl: 'http://old.test', apiKey: '' },
    { id: 'dup', label: 'First', baseUrl: 'https://1.test', apiKey: '' },
    { id: 'dup', label: 'Second', baseUrl: 'https://2.test', apiKey: '' },
    { id: 'flagged', label: 'F', baseUrl: 'https://f.test', apiKey: '', shared: true },
  ]);
  const view = f.store.get(USER_B_ID).providers;
  assert.deepEqual(view.map((p) => p.id), ['default', 'dup']);
  assert.equal(view.find((p) => p.id === 'dup').label, 'First');
});

test('a private file that cannot be read means no private providers, never the last rows read', (t) => {
  const f = fixture(t);
  f.write(f.files.private(USER_B_ID), [{ id: 'mine', label: 'Mine', baseUrl: 'https://b.test/v1', apiKey: '', shared: false }]);
  const ws = f.store.get(USER_B_ID);
  assert.equal(ws.providers.length, 2);
  // A providers.json whose `providers` is not a list cannot be iterated: no private rows.
  fs.writeFileSync(f.files.private(USER_B_ID), '{"providers":{"not":"a list"}}');
  assert.deepEqual(f.store.get(USER_B_ID).providers.map((p) => p.id), ['default']);
  // A directory where the file should be (stat works, read fails): the same.
  fs.rmSync(f.files.private(USER_B_ID));
  fs.mkdirSync(f.files.private(USER_B_ID));
  assert.deepEqual(f.store.get(USER_B_ID).providers.map((p) => p.id), ['default']);
  fs.rmdirSync(f.files.private(USER_B_ID));
  assert.deepEqual(f.store.get(USER_B_ID).providers.map((p) => p.id), ['default']);
});

// ── #782: an unreadable stored key never takes the workspace down ───────────

const OTHER_KEY = Buffer.alloc(32, 7);
function cipherFromAnotherKey(plain) {
  // A value sealed under a key this server does not have (secrets.key restored without its
  // rows, or secrets.key.previous removed after a rotation that left failures).
  const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-other-key-'));
  fs.writeFileSync(path.join(otherDir, 'secrets.key'), OTHER_KEY, { mode: 0o600 });
  const value = createSecretStore(otherDir).encrypt(plain);
  fs.rmSync(otherDir, { recursive: true, force: true });
  return value;
}

test('#782: a provider key no key opens leaves get() working and flags the row for re-entry', (t) => {
  const f = fixture(t);
  const unreadable = cipherFromAnotherKey('sk-synthetic-lost');
  assert.throws(() => f.secrets.decrypt(unreadable), 'the fixture really is unreadable here');
  f.write(f.files.shared, [
    { id: 'shared-lost', label: 'Lost', baseUrl: 'https://lost.test/v1', apiKey: unreadable, shared: true },
    { id: 'shared-ok', label: 'Fine', baseUrl: 'https://ok.test/v1', apiKey: f.secrets.encrypt('sk-synthetic-ok'), shared: true },
  ]);
  f.write(f.files.private(USER_B_ID), [{ id: 'mine-lost', label: 'Mine', baseUrl: 'https://mine.test/v1', apiKey: unreadable }]);
  const user = f.store.get(USER_B_ID);
  const lost = user.providers.find((p) => p.id === 'shared-lost');
  assert.deepEqual([lost.apiKey, lost.keyUnreadable], ['', true]);
  assert.equal(user.providers.find((p) => p.id === 'shared-ok').apiKey, 'sk-synthetic-ok', 'other rows still decrypt');
  const mine = user.providers.find((p) => p.id === 'mine-lost');
  assert.deepEqual([mine.apiKey, mine.keyUnreadable], ['', true]);
  assert.ok(!JSON.stringify(user.providers).includes(unreadable), 'the ciphertext is not on the row');
  // Node does not write the file back: the front keeps the ciphertext as it was.
  assert.equal(JSON.parse(fs.readFileSync(f.files.private(USER_B_ID), 'utf8')).providers[0].apiKey, unreadable);
});

// ── The one write Node keeps: sealing a plaintext key through the project store ──────────

test('a plaintext key left in providers.json is sealed once, through the project store', async (t) => {
  const f = fixture(t);
  const sealed = f.secrets.encrypt('synthetic-sealed-key');
  f.write(f.files.private(USER_B_ID), [
    { id: 'plain', label: 'Plain', baseUrl: 'https://p.test/v1', apiKey: 'synthetic-plain-key', shared: false },
    { id: 'sealed', label: 'Sealed', baseUrl: 'https://s.test/v1', apiKey: sealed, shared: false },
    { id: 'none', label: 'None', baseUrl: 'https://n.test/v1', apiKey: '', shared: false },
  ]);
  const ws = f.store.get(USER_B_ID);
  assert.equal(ws.providers.find((p) => p.id === 'plain').apiKey, 'synthetic-plain-key', 'usable at once');
  await ws.sealLegacyProviders();
  assert.deepEqual(f.projectStore.writes, ['providers.json'], 'written through the store, not by Node');
  const rows = JSON.parse(fs.readFileSync(f.files.private(USER_B_ID), 'utf8')).providers;
  assert.match(rows[0].apiKey, /^enc:v1:/);
  assert.equal(f.secrets.decrypt(rows[0].apiKey), 'synthetic-plain-key');
  assert.equal(rows[1].apiKey, sealed, 'a key that was sealed is left exactly as it was');
  assert.equal(rows[2].apiKey, '');
  // The workspace sees the new file and has nothing left to seal.
  assert.equal(f.store.get(USER_B_ID).needsKeySeal(), false);
  assert.equal(f.store.get(USER_B_ID).providers.find((p) => p.id === 'plain').apiKey, 'synthetic-plain-key');
  await f.store.get(USER_B_ID).sealLegacyProviders();
  assert.deepEqual(f.projectStore.writes, ['providers.json'], 'a second pass writes nothing');
});

test('the seal merges again when the front wrote meanwhile, and a failing store never blocks the workspace', async (t) => {
  const f = fixture(t);
  f.write(f.files.private(USER_B_ID), [{ id: 'plain', label: 'Plain', baseUrl: 'https://p.test/v1', apiKey: 'synthetic-plain-key', shared: false }]);
  // The front adds a row between Node's read and its write: the first write conflicts.
  const inner = f.projectStore;
  let injected = false;
  const racing = { ...inner, read: inner.read, write: async (user, file, version, text) => {
    if (!injected) {
      injected = true;
      const doc = JSON.parse(fs.readFileSync(f.files.private(USER_B_ID), 'utf8'));
      doc.providers.push({ id: 'added-by-front', label: 'Added', baseUrl: 'https://a.test/v1', apiKey: '', shared: false });
      fs.writeFileSync(f.files.private(USER_B_ID), JSON.stringify(doc, null, 2));
    }
    return inner.write(user, file, version, text);
  } };
  const store = createWorkspaceStore(f.root, DEFAULT, f.secrets, { projectStore: racing });
  await store.get(USER_B_ID).sealLegacyProviders();
  const rows = JSON.parse(fs.readFileSync(f.files.private(USER_B_ID), 'utf8')).providers;
  assert.deepEqual(rows.map((r) => r.id), ['plain', 'added-by-front'], 'the front\'s row survived');
  assert.match(rows[0].apiKey, /^enc:v1:/);

  // A store that fails: the workspace still loads and works; the failure is logged, not thrown, and
  // not retried by every request.
  const g = fixture(t);
  g.write(g.files.private(USER_B_ID), [{ id: 'plain', label: 'Plain', baseUrl: 'https://p.test/v1', apiKey: 'synthetic-plain-key', shared: false }]);
  let attempts = 0;
  const failing = { ...g.projectStore, read: async () => { attempts += 1; throw new Error('store down'); } };
  const warn = console.warn; const warned = [];
  console.warn = (...a) => warned.push(a.join(' '));
  try {
    const store2 = createWorkspaceStore(g.root, DEFAULT, g.secrets, { projectStore: failing });
    const ws = store2.get(USER_B_ID);
    assert.equal(ws.providers.find((p) => p.id === 'plain').apiKey, 'synthetic-plain-key');
    await ws.sealLegacyProviders();
    store2.get(USER_B_ID); store2.get(USER_B_ID);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(attempts, 1, 'one attempt, then quiet');
    assert.equal(warned.length, 1);
    assert.doesNotMatch(warned[0], /synthetic-plain-key/);
  } finally { console.warn = warn; }
});
