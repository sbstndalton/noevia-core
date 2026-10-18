'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const sqliteModule = require.resolve('better-sqlite3', { paths: [__dirname] });
const { createAuth } = require('./auth.cjs');
const { seedAccount } = require('../tests/server/seed-account.cjs');
const { createWorkspaceStore } = require('./workspace.cjs');
const { createStubStore } = require('../tests/server/project-store-stub.cjs');
const { claimLegacyRoot, MAX_BYTES, MAX_ENTRIES, MAX_DEPTH } = require('./legacy-claim.cjs');

const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
function rootFor(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-claim-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function mode(file) { return fs.statSync(file).mode & 0o777; }

test('copies the original claim set to a private backup and target with a recoverable marker', (t) => {
  const root = rootFor(t);
  fs.writeFileSync(path.join(root, 'projects.json'), '{"projects":[{"id":"old"}]}');
  fs.writeFileSync(path.join(root, 'providers.json'), '{"providers":[{"apiKey":"secret"}]}');
  fs.writeFileSync(path.join(root, 'free-chats.json'), '[{"id":"free"}]');
  fs.writeFileSync(path.join(root, 'auto-roles.json'), '{"x":true}');
  fs.writeFileSync(path.join(root, 'history-chat.json'), '{"messages":[]}');
  fs.mkdirSync(path.join(root, 'rag'));
  fs.writeFileSync(path.join(root, 'rag', 'index.bin'), Buffer.from([0, 1, 2, 255]));

  assert.equal(claimLegacyRoot(root, owner), true);
  const target = path.join(root, 'users', owner);
  const marker = JSON.parse(fs.readFileSync(path.join(target, 'migration.json'), 'utf8'));
  assert.equal(marker.version, 1);
  assert.equal(marker.source, 'legacy-root');
  assert.equal(JSON.parse(fs.readFileSync(path.join(target, 'projects.json'), 'utf8')).projects[0].id, 'old');
  assert.deepEqual(fs.readFileSync(path.join(target, 'rag', 'index.bin')), Buffer.from([0, 1, 2, 255]));
  assert.equal(fs.readFileSync(path.join(marker.backup, 'providers.json'), 'utf8'), fs.readFileSync(path.join(root, 'providers.json'), 'utf8'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'legacy-owner.json'), 'utf8')).userId, owner);
  assert.equal(fs.existsSync(path.join(root, 'projects.json')), true, 'source remains for recovery');
  assert.equal(mode(target), 0o700);
  assert.equal(mode(marker.backup), 0o700);
  assert.equal(mode(path.join(target, 'providers.json')), 0o600);
});

test('preserves trigger asymmetry and prevents later admins from claiming retained data', (t) => {
  const root = rootFor(t);
  fs.writeFileSync(path.join(root, 'free-chats.json'), '[]');
  fs.writeFileSync(path.join(root, 'auto-roles.json'), '{}');
  fs.mkdirSync(path.join(root, 'rag'));
  assert.equal(claimLegacyRoot(root, owner), false);
  assert.equal(fs.existsSync(path.join(root, 'legacy-owner.json')), false);

  fs.writeFileSync(path.join(root, 'projects.json'), '{"projects":[]}');
  assert.equal(claimLegacyRoot(root, owner), true);
  fs.rmSync(path.join(root, 'users', owner), { recursive: true });
  assert.equal(claimLegacyRoot(root, other), false);
  assert.equal(fs.existsSync(path.join(root, 'users', other)), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'legacy-owner.json'), 'utf8')).userId, owner);
});

test('recovers the prior migration owner when legacy-owner.json is absent', (t) => {
  const root = rootFor(t);
  fs.writeFileSync(path.join(root, 'projects.json'), '{"projects":[]}');
  fs.mkdirSync(path.join(root, 'users', owner), { recursive: true });
  fs.writeFileSync(path.join(root, 'users', owner, 'migration.json'), '{}');
  assert.equal(claimLegacyRoot(root, other), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'legacy-owner.json'), 'utf8')).userId, owner);
  assert.equal(fs.existsSync(path.join(root, 'users', other)), false);
});

test('fails closed on malformed ownership markers, symlinks, oversized or over-deep trees', (t) => {
  const malformed = rootFor(t);
  fs.writeFileSync(path.join(malformed, 'projects.json'), '{}');
  fs.writeFileSync(path.join(malformed, 'legacy-owner.json'), '{');
  assert.equal(claimLegacyRoot(malformed, owner), false);
  assert.equal(fs.existsSync(path.join(malformed, 'users', owner)), false);

  const linked = rootFor(t);
  fs.writeFileSync(path.join(linked, 'projects.json'), '{}');
  const outside = path.join(linked, 'outside.json');
  fs.writeFileSync(outside, 'private');
  fs.symlinkSync(outside, path.join(linked, 'history-link.json'));
  assert.throws(() => claimLegacyRoot(linked, owner), (e) => e.status === 503);
  assert.equal(fs.existsSync(path.join(linked, 'users', owner)), false);
  assert.equal(fs.existsSync(path.join(linked, 'migration-backups')), false);

  const large = rootFor(t);
  fs.writeFileSync(path.join(large, 'projects.json'), '{}');
  fs.writeFileSync(path.join(large, 'providers.json'), Buffer.alloc(MAX_BYTES + 1));
  assert.throws(() => claimLegacyRoot(large, owner), (e) => e.status === 503 && /size limit/.test(e.message));
  assert.equal(fs.existsSync(path.join(large, 'users', owner)), false);
  assert.equal(fs.existsSync(path.join(large, 'migration-backups')), false);
  assert.equal(fs.existsSync(path.join(large, 'legacy-owner.json')), false);

  const deep = rootFor(t);
  fs.writeFileSync(path.join(deep, 'projects.json'), '{}');
  let current = path.join(deep, 'rag');
  fs.mkdirSync(current);
  for (let i = 0; i < MAX_DEPTH + 1; i++) { current = path.join(current, 'd'); fs.mkdirSync(current); }
  assert.throws(() => claimLegacyRoot(deep, owner), (e) => e.status === 503 && /depth limit/.test(e.message));
  assert.equal(fs.existsSync(path.join(deep, 'users', owner)), false);

  const many = rootFor(t);
  fs.writeFileSync(path.join(many, 'projects.json'), '{}');
  fs.mkdirSync(path.join(many, 'rag'));
  for (let i = 0; i < MAX_ENTRIES; i++) fs.writeFileSync(path.join(many, 'rag', String(i)), '');
  assert.throws(() => claimLegacyRoot(many, owner), (e) => e.status === 503 && /entry limit/.test(e.message));
  assert.equal(fs.existsSync(path.join(many, 'users', owner)), false);
});


test('workspace claim runs inside the same real auth database transaction', (t) => {
  const root = rootFor(t);
  const auth = createAuth({ dataDir: root, publicOrigin: 'https://cowork.example.test' });
  t.after(() => auth.db.close());
  const admin = seedAccount(root, { username: 'claim-admin' });
  fs.writeFileSync(path.join(root, 'projects.json'), '{"projects":[]}');
  const request = { headers: { cookie: admin.cookie }, socket: { remoteAddress: '127.0.0.1' } };
  const store = createWorkspaceStore(root, { id: 'default', label: 'Default', apiKey: '' }, null, { projectStore: createStubStore(root) });
  let transactionCalls = 0;
  const workspace = store.get(admin.id, {
    claim: true,
    claimTransaction: (claim) => auth.db.transaction(() => {
      transactionCalls++;
      assert.equal(auth.db.inTransaction, true);
      const live = auth.authenticate(request);
      assert.equal(live.user.id, admin.id);
      assert.equal(live.user.role, 'admin');
      return claim();
    }).immediate(),
  });
  assert.equal(transactionCalls, 1);
  assert.equal(fs.existsSync(path.join(workspace.dir, 'migration.json')), true);
  const laterWorkspace = store.get(admin.id, {
    claim: true,
    claimTransaction: () => { transactionCalls++; throw new Error('already-claimed get must not enter a write transaction'); },
  });
  assert.equal(laterWorkspace, workspace);
  assert.equal(transactionCalls, 1);
});

test('a separate process deleting the account first prevents a Node legacy claim', async (t) => {
  const root = rootFor(t);
  const auth = createAuth({ dataDir: root, publicOrigin: 'https://cowork.example.test' });
  t.after(() => auth.db.close());
  const admin = seedAccount(root, { username: 'claim-target' });
  seedAccount(root, { username: 'claim-actor' });
  fs.writeFileSync(path.join(root, 'projects.json'), '{"projects":[]}');
  const request = { headers: { cookie: admin.cookie }, socket: { remoteAddress: '127.0.0.1' } };
  const script = [
    "const Database=require(process.argv[3]);",
    "const path=require('node:path');",
    "const root=process.argv[1], user=process.argv[2];",
    "const db=new Database(path.join(root,'cowork.db')); db.pragma('busy_timeout=5000');",
    "db.exec('BEGIN IMMEDIATE'); process.stdout.write('LOCKED\\n');",
    "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,120);",
    "db.prepare('DELETE FROM users WHERE id=?').run(user); db.exec('COMMIT'); db.close();",
    "require('node:fs').rmSync(path.join(root,'users',user),{recursive:true,force:true});",
  ].join('');
  const child = spawn(process.execPath, ['-e', script, root, admin.id, sqliteModule], { stdio: ['ignore', 'pipe', 'inherit'] });
  const childExit = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`delete helper exited ${code}`)));
  });
  t.after(() => { if (!child.killed) child.kill(); });
  await new Promise((resolve, reject) => {
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('LOCKED\n')) resolve();
    });
    child.once('error', reject);
  });
  const store = createWorkspaceStore(root, { id: 'default', label: 'Default', apiKey: '' }, null, { projectStore: createStubStore(root) });
  assert.throws(() => store.get(admin.id, {
    claim: true,
    claimTransaction: (claim) => auth.db.transaction(() => {
      const live = auth.authenticate(request);
      if (!live || live.user.id !== admin.id || live.user.role !== 'admin') {
        throw Object.assign(new Error('account authorization changed'), { status: 410 });
      }
      return claim();
    }).immediate(),
  }), (error) => error.status === 410);
  await childExit;
  assert.equal(fs.existsSync(path.join(root, 'users', admin.id)), false);
  assert.equal(fs.existsSync(path.join(root, 'projects.json')), true);
  assert.equal(fs.existsSync(path.join(root, 'legacy-owner.json')), false);
});
