'use strict';
// #2190, #2191 round 9 (review M1): the Rust front deletes an account (the row, then the folder) and tells this
// process nothing, so "this account is gone" is a question for the auth database. workspaceStore.isRemoved asks it
// (kept for about a second, because rag asks once per chunk), latches the answer, and revokes a held workspace.
// Everything here is synthetic: the real createWorkspaceStore and the real rag.cjs, a stand-in user table and a
// stand-in embedding endpoint.
delete process.env.RAG_DIR;
delete process.env.EMBEDDING_BASE_URL;
delete process.env.EMBEDDING_MODEL;
delete process.env.EMBED_MODEL;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const rag = require('./rag.cjs');
const { createWorkspaceStore } = require('./workspace.cjs');
const { createStubStore } = require('../tests/server/project-store-stub.cjs');

const USER = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-2222-4333-8444-555555555555';
const DEFAULT = { id: 'local', label: 'Local', baseUrl: '', apiKey: '' };

function world(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-removed-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rows = new Set([USER, OTHER]);
  const clock = { t: 1_000_000 };
  const asked = [];
  const ws = createWorkspaceStore(root, DEFAULT, null, {
    projectStore: createStubStore(root),
    userExists: (id) => { asked.push(id); return rows.has(id); },
    now: () => clock.t,
  });
  return { root, rows, clock, asked, ws };
}

test('isRemoved asks the auth database without any get(), and answers true for an account with no row', (t) => {
  const { rows, ws, root } = world(t);
  rows.delete(USER);
  assert.equal(ws.isRemoved(USER), true, 'a row that is gone, with no workspace ever made');
  assert.equal(ws.isRemoved(OTHER), false);
  assert.equal(fs.existsSync(path.join(root, 'users', USER)), false, 'asking made no folder');
  // Latched: the answer holds even if the row came back (a database restore does not revive a running process's view).
  rows.add(USER);
  assert.equal(ws.isRemoved(USER), true);
  assert.throws(() => ws.get(USER), (e) => e.status === 410);
});

test('an "exists" answer is kept for about a second, then asked again', (t) => {
  const { rows, clock, asked, ws } = world(t);
  assert.equal(ws.isRemoved(USER), false);
  for (let i = 0; i < 50; i += 1) assert.equal(ws.isRemoved(USER), false);
  assert.equal(asked.length, 1, 'rag calls this once per chunk: the database is not asked each time');
  rows.delete(USER);
  clock.t += 500;
  assert.equal(ws.isRemoved(USER), false, 'still inside the window');
  clock.t += 600;
  assert.equal(ws.isRemoved(USER), true, 'seen once the window has passed');
  assert.equal(asked.length, 2);
  // A clock that went backwards asks again rather than trusting an answer from the future.
  clock.t -= 10_000;
  assert.equal(ws.isRemoved(OTHER), false);
  clock.t -= 10_000;
  assert.equal(ws.isRemoved(OTHER), false);
  assert.equal(asked.filter((id) => id === OTHER).length, 2);
});

test('an unreadable database is not an answer: the account counts as there and is asked about again', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-removed-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let broken = true;
  const ws = createWorkspaceStore(root, DEFAULT, null, { projectStore: createStubStore(root), userExists: () => { if (broken) throw new Error('database is locked'); return true; } });
  assert.equal(ws.isRemoved(USER), false);
  assert.equal(ws.isRemoved(USER), false, 'nothing was latched');
  broken = false;
  assert.equal(ws.isRemoved(USER), false);
});

test('finding the account gone revokes the workspace held for it, at once', (t) => {
  const { rows, clock, ws } = world(t);
  const held = ws.get(USER);
  assert.doesNotThrow(() => held.assertActive());
  rows.delete(USER);
  clock.t += 2000;
  assert.equal(ws.isRemoved(USER), true);
  assert.throws(() => held.assertActive(), (e) => e.status === 410, 'the folder is still there: only the database said so');
  assert.throws(() => ws.get(USER), (e) => e.status === 410);
});

test('rag stops for an account whose row is gone: openIndex opens nothing and makes no folder', (t) => {
  if (!rag.ragAvailable()) { t.skip('local SQLite vector dependency unavailable'); return; }
  const { rows, clock, ws, root } = world(t);
  rag.init({ dataDir: root, embedModel: 'fake-embed', inferenceUrl: 'http://embedder.invalid',
    userDataDirFn: (id) => path.join(root, 'users', id), userActive: (id) => !ws.isRemoved(id) });
  // Control: an account with a row gets its index, so a null below is the check and not a missing dependency.
  const live = rag._test.openIndex('p-live', OTHER);
  assert.ok(live, 'the control account has an index');
  live.db.close();
  assert.ok(fs.existsSync(path.join(root, 'users', OTHER, 'rag')));
  // The Rust front deletes the account: the row, then the folder. No get() has happened for it in this process.
  rows.delete(USER);
  clock.t += 2000;
  assert.equal(rag._test.openIndex('p-gone', USER), null);
  assert.equal(fs.existsSync(path.join(root, 'users', USER)), false, 'no users/<id> folder was made');
});

test('an embed in flight when the account is deleted stops writing, and rag lists nothing for it', async (t) => {
  if (!rag.ragAvailable()) { t.skip('local SQLite vector dependency unavailable'); return; }
  const { rows, clock, ws, root } = world(t);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let reached;
  const reachedP = new Promise((resolve) => { reached = resolve; });
  const priorFetch = rag._test.setRagFetch(async (url, options) => {
    const { input } = JSON.parse(options.body);
    if (input.length > 1) { reached(); await gate; }
    return { ok: true, json: async () => ({ data: input.map(() => ({ embedding: [1, 0, 0, 0] })) }) };
  });
  rag.init({ dataDir: root, embedModel: 'fake-embed', inferenceUrl: 'http://embedder.invalid',
    userDataDirFn: (id) => path.join(root, 'users', id), userActive: (id) => !ws.isRemoved(id), listUserIds: () => [USER, OTHER] });
  try {
    const running = rag.indexProjectFile('p-delete', 'doc.txt', 'zebra '.repeat(500), USER);
    await reachedP;
    assert.ok(fs.existsSync(path.join(root, 'users', USER)), 'the index was opened before the deletion');
    // The front deletes the row and the folder behind rag's back, and the embed resumes.
    rows.delete(USER);
    fs.rmSync(path.join(root, 'users', USER), { recursive: true, force: true });
    clock.t += 2000;
    release();
    const out = await running;
    assert.equal(out.embedded, 0, 'the resumed embed writes no vector for a deleted account');
    assert.equal(fs.existsSync(path.join(root, 'users', USER)), false, 'nothing made the account\'s folder again');
    // The index listing (reindex and repair passes) skips the deleted account's id.
    fs.mkdirSync(path.join(root, 'users', OTHER, 'rag'), { recursive: true });
    fs.writeFileSync(path.join(root, 'users', OTHER, 'rag', 'p-other.db'), '');
    assert.deepEqual(rag.listIndexes().map((e) => e.userId), [OTHER]);
  } finally {
    release();
    rag._test.setRagFetch(priorFetch);
  }
});
