'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createAuth } = require('./auth.cjs');
const { createSecretStore } = require('./secrets.cjs');
const { createWorkspaceStore } = require('./workspace.cjs');
const { createStubStore } = require('../tests/server/project-store-stub.cjs');

// Sign-in, invitations, recovery, disabling an account and first-run setup are the Rust front's
// (sbstndalton/noevia#1071; noevia-rs crates/server-account). The accounts and their tokens are
// written here through a separate connection, as the front writes them; what is tested is what
// stays Node's: the origin check, and per-account workspaces. Deleting an account is the front's too
// since #2190/#2191 round 9 (crates/server-account delete.rs carries the deletion tests).
const Database = require('better-sqlite3');
const { seedAccount } = require('../tests/server/seed-account.cjs');
const asFront = (root, fn) => { const db = new Database(path.join(root, 'cowork.db')); try { return fn(db); } finally { db.close(); } };

function deletionFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-delete-admin-'));
  const auth = createAuth({ dataDir: root, publicOrigin: 'https://cowork.example.test' });
  t.after(() => { auth.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const firstId = seedAccount(root, { username: 'first' }).id;
  const secondId = seedAccount(root, { username: 'second' }).id;
  return { root, auth, firstId, secondId };
}

test('deleting an account is the Rust front\'s: Node has no deleteUser and its guard refuses any delete of users (#2190, #2191 round 9)', t => {
  const { auth, firstId, secondId } = deletionFixture(t);
  assert.equal(auth.deleteUser, undefined);
  const owned = (e) => e && e.status === 503 && e.code === 'RUST_AUTH_OWNED';
  assert.throws(() => auth.db.prepare('DELETE FROM users WHERE id=?').run(secondId), owned);
  assert.throws(() => auth.rustAuth.exempt(() => auth.db.prepare('DELETE FROM users WHERE id=?').run(secondId)), owned, 'not even inside exempt()');
  assert.deepEqual(auth.listUsers().map((u) => u.id), [firstId, secondId]);
});

test('the Diary preference is read per account, and workspaces are isolated', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-system-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const secrets = createSecretStore(root);
  const auth = createAuth({ dataDir: root, publicOrigin: 'https://cowork.example.test', rpId: 'cowork.example.test', secrets });
  t.after(() => auth.db.close());
  const owner = seedAccount(root, { username: 'Owner', diaryEnabled: true });
  const member = seedAccount(root, { username: 'member', role: 'member', diaryEnabled: false });
  assert.equal(auth.diaryEnabled(owner.id), true);
  assert.equal(auth.diaryEnabled(member.id), false);
  assert.deepEqual(auth.listUsers().map((u) => [u.username, u.role]), [['Owner', 'admin'], ['member', 'member']]);
  const store = createWorkspaceStore(root, { id: 'default', label: 'Default', baseUrl: 'http://localhost', apiKey: '' }, secrets, { projectStore: createStubStore(root) });
  const ownerSpace = store.get(owner.id); const memberSpace = store.get(member.id);
  ownerSpace.projects.push({ id: 'private-project', name: 'Private' }); ownerSpace.saveProjects();
  assert.equal(memberSpace.projects.length, 0);
  assert.notEqual(ownerSpace.dir, memberSpace.dir);
});

test('additionalOrigins lets a second origin (e.g. a LAN IP) pass the origin check without trusting any other', () => {
  // Regression for: password login 403s with "origin not allowed" when a deployment is reachable
  // from both a Cloudflare Tunnel hostname (the configured publicOrigin) and a bare LAN IP. Node's
  // routes still check the Origin of every signed-in write with the same rule.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-multi-origin-'));
  const auth = createAuth({
    dataDir: root,
    publicOrigin: 'https://cowork.example.test',
    rpId: 'cowork.example.test',
    secrets: createSecretStore(root),
    additionalOrigins: ['http://10.0.0.5:8021'],
  });
  try {
    const from = (origin) => ({ headers: { origin, 'user-agent': 'test' }, socket: { remoteAddress: '127.0.0.1' } });
    assert.equal(auth.originValid(from('http://evil.example.test')), false);
    assert.equal(auth.originValid(from('http://10.0.0.5:8021')), true);
    assert.equal(auth.originValid(from('https://cowork.example.test')), true);
  } finally { auth.db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('provider secrets the front sealed decrypt for their owner, and a plaintext key left on disk is sealed through the store', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-secrets-'));
  const secrets = createSecretStore(root); const id = '22222222-2222-4222-8222-222222222222';
  const stub = createStubStore(root);
  const store = createWorkspaceStore(root, { id: 'default', label: 'Default', baseUrl: 'http://localhost', apiKey: '' }, secrets, { projectStore: stub });
  const workspace = store.get(id);
  const file = path.join(workspace.dir, 'providers.json');
  // The Rust front writes the rows (noevia-rs provider_routes.rs): sealed enc:v1.
  fs.writeFileSync(file, JSON.stringify({ providers: [{ id: 'private', label: 'Private', baseUrl: 'https://example.test/v1', apiKey: secrets.encrypt('super-secret-key') }] }));
  assert.equal(store.get(id).providers.find((p) => p.id === 'private').apiKey, 'super-secret-key');
  // A file from before sealing: usable, then sealed by the one write Node keeps, through the store.
  fs.writeFileSync(file, JSON.stringify({ providers: [{ id: 'private', label: 'Private', baseUrl: 'https://example.test/v1', apiKey: 'super-secret-key' }] }));
  const ws = store.get(id);
  assert.equal(ws.providers.find((p) => p.id === 'private').apiKey, 'super-secret-key');
  await ws.sealLegacyProviders();
  const raw = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(raw, /super-secret-key/); assert.match(raw, /enc:v1:/);
  assert.deepEqual(stub.writes, ['providers.json']);
  fs.rmSync(root, { recursive: true, force: true });
});
