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
// stays Node's: deleting an account, the origin check, and per-account workspaces.
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

test('deleting an administrator revokes issued invite/recovery tokens but preserves other users and audit history', t => {
  const { root, auth, firstId, secondId } = deletionFixture(t);
  const now = Date.now();
  asFront(root, (db) => {
    db.prepare('INSERT INTO invitations(token_hash,created_by,role,expires_at,created_at) VALUES(?,?,?,?,?)').run('synthetic-invite', secondId, 'member', now + 86400000, now);
    db.prepare('INSERT INTO recoveries(token_hash,user_id,created_by,expires_at,created_at) VALUES(?,?,?,?,?)').run('synthetic-recovery', firstId, secondId, now + 3600000, now);
    db.prepare("INSERT INTO audit_events(actor_user_id,target_user_id,action,detail,created_at) VALUES(?,NULL,'invite.create','{}',?)").run(secondId, now);
  });
  assert.equal(auth.deleteUser(firstId, secondId, 'wrong-name'), false);
  assert.equal(auth.deleteUser(firstId, secondId, 'second'), true);
  assert.deepEqual(auth.listUsers().map(u => u.id), [firstId]);
  assert.equal(auth.db.prepare('SELECT count(*) AS n FROM invitations').get().n, 0, 'the invitation it issued is revoked');
  assert.equal(auth.db.prepare('SELECT count(*) AS n FROM recoveries').get().n, 0, 'the recovery link it issued is revoked');
  assert.equal(auth.db.prepare('SELECT count(*) AS n FROM sessions WHERE user_id=?').get(secondId).n, 0);
  assert.equal(auth.db.prepare('SELECT count(*) AS n FROM sessions WHERE user_id=?').get(firstId).n, 1, 'the other account keeps its session');
  assert.ok(auth.db.prepare("SELECT 1 FROM audit_events WHERE actor_user_id=? AND action='invite.create'").get(secondId));
  assert.ok(auth.db.prepare("SELECT 1 FROM audit_events WHERE target_user_id=? AND action='user.delete'").get(secondId));
});

test('a disabled administrator cannot make deletion of the last active administrator safe', t => {
  const { root, auth, firstId, secondId } = deletionFixture(t);
  asFront(root, (db) => db.prepare('UPDATE users SET disabled_at=? WHERE id=?').run(Date.now(), secondId));
  assert.throws(() => auth.deleteUser(firstId, firstId, 'first'), /last active administrator/);
  assert.equal(auth.listUsers().length, 2);
  assert.equal(auth.deleteUser(firstId, secondId, 'second'), true);
  assert.throws(() => auth.deleteUser(firstId, firstId, 'first'), /last active administrator/);
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

test('provider secrets are encrypted on disk and decrypt for their owner', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-secrets-'));
  const secrets = createSecretStore(root); const id = '22222222-2222-4222-8222-222222222222';
  const store = createWorkspaceStore(root, { id: 'default', label: 'Default', baseUrl: 'http://localhost', apiKey: '' }, secrets, { projectStore: createStubStore(root) });
  const workspace = store.get(id); workspace.providers.push({ id: 'private', label: 'Private', baseUrl: 'https://example.test/v1', apiKey: 'super-secret-key' }); workspace.saveProviders();
  const raw = fs.readFileSync(path.join(workspace.dir, 'providers.json'), 'utf8');
  assert.doesNotMatch(raw, /super-secret-key/); assert.match(raw, /enc:v1:/);
  fs.rmSync(root, { recursive: true, force: true });
});
