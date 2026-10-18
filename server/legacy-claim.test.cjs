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
const { claimLegacyRoot, hasLegacy, needsClaim, MAX_ENTRIES } = require('./legacy-claim.cjs');

const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
function rootFor(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-claim-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function executableFor(t, body) {
  const root = rootFor(t);
  const file = path.join(root, 'claim-helper');
  fs.writeFileSync(file, '#!/bin/sh\nset -eu\n' + body, { mode: 0o700 });
  fs.chmodSync(file, 0o700);
  return file;
}
function useHelper(t, file) {
  const previous = process.env.NOEVIA_LEGACY_CLAIM_BIN;
  process.env.NOEVIA_LEGACY_CLAIM_BIN = file;
  t.after(() => {
    if (previous === undefined) delete process.env.NOEVIA_LEGACY_CLAIM_BIN;
    else process.env.NOEVIA_LEGACY_CLAIM_BIN = previous;
  });
}

test('bounded legacy hint recognizes known triggers and treats overflow as maybe', (t) => {
  const root = rootFor(t);
  assert.equal(hasLegacy(root), false);
  assert.equal(needsClaim(root, owner), false);
  fs.writeFileSync(path.join(root, 'history-chat.json'), '{}');
  assert.equal(hasLegacy(root), true);
  fs.rmSync(path.join(root, 'history-chat.json'));
  for (let i = 0; i <= MAX_ENTRIES; i++) fs.writeFileSync(path.join(root, 'noise-' + i), '');
  assert.equal(hasLegacy(root), true, 'overflow must defer to native bounded authority');
});

test('bounded hint suppresses only a complete same-owner target or known other owner', (t) => {
  const root = rootFor(t);
  fs.writeFileSync(path.join(root, 'projects.json'), '{}');
  assert.equal(needsClaim(root, owner), true);
  fs.writeFileSync(path.join(root, 'legacy-owner.json'), JSON.stringify({ userId: other }));
  assert.equal(needsClaim(root, owner), false);
  fs.writeFileSync(path.join(root, 'legacy-owner.json'), JSON.stringify({ userId: owner }));
  fs.mkdirSync(path.join(root, 'users', owner), { recursive: true });
  assert.equal(needsClaim(root, owner), false);
  fs.rmSync(path.join(root, 'users', owner), { recursive: true });
  fs.symlinkSync(root, path.join(root, 'users', owner));
  assert.equal(needsClaim(root, owner), true, 'linked target must reach native refusal path');
});

test('legacy helper requires an explicit absolute executable and accepts only fixed replies', (t) => {
  const root = rootFor(t);
  fs.writeFileSync(path.join(root, 'projects.json'), '{}');
  const previous = process.env.NOEVIA_LEGACY_CLAIM_BIN;
  delete process.env.NOEVIA_LEGACY_CLAIM_BIN;
  t.after(() => { if (previous !== undefined) process.env.NOEVIA_LEGACY_CLAIM_BIN = previous; });
  assert.throws(() => claimLegacyRoot(root, owner), (error) => error.status === 503);
  process.env.NOEVIA_LEGACY_CLAIM_BIN = 'claim-helper';
  assert.throws(() => claimLegacyRoot(root, owner), (error) => error.status === 503);

  const claimed = executableFor(t, 'test "$1" = "--claim-legacy-root"\ntest "$2" = "' + root + '"\ntest "$3" = "' + owner + '"\nprintf "CLAIMED\\n"\n');
  process.env.NOEVIA_LEGACY_CLAIM_BIN = claimed;
  assert.equal(claimLegacyRoot(root, owner), true);

  const skipped = executableFor(t, 'printf "SKIPPED\\n"\n');
  process.env.NOEVIA_LEGACY_CLAIM_BIN = skipped;
  assert.equal(claimLegacyRoot(root, owner), false);

  const malformed = executableFor(t, 'printf "sensitive child output"\n');
  process.env.NOEVIA_LEGACY_CLAIM_BIN = malformed;
  assert.throws(() => claimLegacyRoot(root, owner), (error) =>
    error.status === 503 && !error.message.includes('sensitive child output'));
});

test('helper timeout is bounded and becomes a generic unavailable response', (t) => {
  const root = rootFor(t);
  const helper = executableFor(t, 'exec sleep 10\n');
  useHelper(t, helper);
  const started = Date.now();
  assert.throws(() => claimLegacyRoot(root, owner), (error) => error.status === 503);
  assert.ok(Date.now() - started < 9200, 'wrapper timeout covers both bounded legacy scans, root lock, claim work and slop');
});

test('nonlegacy workspace get takes the fast path without a configured child' , (t) => {
  const root = rootFor(t);
  const previous = process.env.NOEVIA_LEGACY_CLAIM_BIN;
  delete process.env.NOEVIA_LEGACY_CLAIM_BIN;
  t.after(() => { if (previous !== undefined) process.env.NOEVIA_LEGACY_CLAIM_BIN = previous; });
  const store = createWorkspaceStore(root, { id: 'default', label: 'Default', apiKey: '' }, null, { projectStore: createStubStore(root) });
  assert.doesNotThrow(() => store.get(owner, { claim: true }));
});

test('workspace claim runs inside the same fresh admin auth database transaction', (t) => {
  const root = rootFor(t);
  const helper = executableFor(t,
    'test "$1" = "--claim-legacy-root"\nmkdir -p "$2/users/$3"\nprintf "{\\"userId\\":\\"%s\\"}" "$3" > "$2/legacy-owner.json"\nprintf "CLAIMED\\n"\n');
  useHelper(t, helper);
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
  assert.equal(fs.existsSync(path.join(root, 'legacy-owner.json')), true);
  const laterWorkspace = store.get(admin.id, {
    claim: true,
    claimTransaction: () => { transactionCalls++; throw new Error('settled get must not enter a write transaction'); },
  });
  assert.equal(laterWorkspace, workspace);
  assert.equal(transactionCalls, 1);
});

test('actual Rust claim helper is called by Node while the auth write transaction is held', {
  skip: process.env.NOEVIA_LEGACY_CLAIM_REQUIRED !== '1' &&
    (!process.env.NOEVIA_LEGACY_CLAIM_BIN || !path.isAbsolute(process.env.NOEVIA_LEGACY_CLAIM_BIN)),
}, (t) => {
  const root = rootFor(t);
  fs.writeFileSync(path.join(root, 'projects.json'), '{"projects":[]}');
  const auth = createAuth({ dataDir: root, publicOrigin: 'https://cowork.example.test' });
  t.after(() => auth.db.close());
  const admin = seedAccount(root, { username: 'native-claim-admin' });
  const request = { headers: { cookie: admin.cookie }, socket: { remoteAddress: '127.0.0.1' } };
  const store = createWorkspaceStore(root, { id: 'default', label: 'Default', apiKey: '' }, null, { projectStore: createStubStore(root) });
  const workspace = store.get(admin.id, {
    claim: true,
    claimTransaction: (claim) => auth.db.transaction(() => {
      assert.equal(auth.db.inTransaction, true);
      const live = auth.authenticate(request);
      assert.equal(live.user.id, admin.id);
      assert.equal(live.user.role, 'admin');
      return claim();
    }).immediate(),
  });
  assert.equal(fs.existsSync(path.join(workspace.dir, 'migration.json')), true);
  assert.deepEqual(fs.readFileSync(path.join(workspace.dir, 'projects.json')), Buffer.from('{"projects":[]}'));
});

test('a separate process deleting the account first prevents a Node legacy claim', async (t) => {
  const root = rootFor(t);
  const helper = executableFor(t, 'printf "unexpected claim" >&2\nexit 9\n');
  useHelper(t, helper);
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
      if (output.includes('LOCKED')) resolve();
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
