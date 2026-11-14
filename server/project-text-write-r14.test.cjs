'use strict';
// Track R14: the project text write as a store op (project-store-client.cjs textWrite) and core's
// writeProjectTextFile handing it over when NOEVIA_RUST_PROJECT_WRITE=1 (nativeTextWrite).
// The old path stays covered by project-create-files-687.test.cjs. Synthetic data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('./project-store-client.cjs');
const { createProjectStore } = require('./projects.cjs');

const TOKEN = 'synthetic-store-token-0123456789abcdef';

function client(status, body) {
  const calls = [];
  const c = createClient({ port: 12345, token: TOKEN, fetchImpl: async (url, init) => {
    calls.push({ url, headers: init.headers, payload: JSON.parse(init.body) });
    return new Response(JSON.stringify(body), { status });
  } });
  return { c, calls };
}

test('textWrite sends only the defined option keys, null stays null, and returns the file', async () => {
  const file = { name: 'qa-notes.md', content: 'hello' };
  const { c, calls } = client(200, { file });
  const got = await c.textWrite('qa-user', 'qa-project', 'qa-notes.md', 'hello', { expectName: 'qa-notes.md', expectContent: undefined, expectAttachment: null, adoptTo: undefined, adoptAccount: 'qa-acct', ignored: 'x' });
  assert.deepEqual(got, file);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:12345/v1/projects/text-write');
  assert.equal(calls[0].headers['x-noevia-store-token'], TOKEN);
  assert.deepEqual(calls[0].payload, { user: 'qa-user', project: 'qa-project', name: 'qa-notes.md', text: 'hello', expectName: 'qa-notes.md', expectAttachment: null, adoptAccount: 'qa-acct' });
  assert.equal('expectContent' in calls[0].payload, false);
  assert.equal('adoptTo' in calls[0].payload, false);
});

test('textWrite waits longer than the client default (the front may wait 30 s for the source lock)', async (t) => {
  const waits = [];
  const real = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', (ms) => { waits.push(ms); return real(ms); });
  await client(200, { file: { name: 'qa.md' } }).c.textWrite('qa-user', 'qa-project', 'qa.md', 't');
  assert.deepEqual(waits, [330000]);
});

test('textWrite with no options sends the four base keys only', async () => {
  const { c, calls } = client(200, { file: { name: 'qa.md' } });
  await c.textWrite('qa-user', 'qa-project', 'qa.md', '');
  assert.deepEqual(calls[0].payload, { user: 'qa-user', project: 'qa-project', name: 'qa.md', text: '' });
});

test('textWrite maps the front\'s answers: refused, account gone, not taken, unknown', async () => {
  await assert.rejects(client(200, { error: '"qa.md" changed while this edit was being made; nothing was saved.' }).c.textWrite('u', 'p', 'qa.md', 't'),
    (err) => err.message === '"qa.md" changed while this edit was being made; nothing was saved.' && err.code === 'TEXT_WRITE_REFUSED');
  await assert.rejects(client(404, { error: 'no such account' }).c.textWrite('u', 'p', 'qa.md', 't'),
    (err) => err.status === 410 && err.message === 'account no longer exists');
  // An empty 404 is a front without the op (a pairing fault), never "account gone".
  await assert.rejects(client(404, {}).c.textWrite('u', 'p', 'qa.md', 't'), (err) => err.code === 'TEXT_WRITE_NOT_TAKEN' && err.status !== 410);
  for (const status of [400, 401, 503]) {
    await assert.rejects(client(status, { error: 'unavailable' }).c.textWrite('u', 'p', 'qa.md', 't'), (err) => err.code === 'TEXT_WRITE_NOT_TAKEN');
  }
  // After the request left: the outcome is unknown.
  await assert.rejects(client(500, { error: 'internal error' }).c.textWrite('u', 'p', 'qa.md', 't'), (err) => err.code === 'TEXT_WRITE_UNKNOWN');
  await assert.rejects(client(200, {}).c.textWrite('u', 'p', 'qa.md', 't'), (err) => err.code === 'TEXT_WRITE_UNKNOWN');
  const reset = createClient({ port: 12345, token: TOKEN, fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(reset.textWrite('u', 'p', 'qa.md', 't'), (err) => err.code === 'TEXT_WRITE_UNKNOWN');
});

function storeWith(nativeTextWrite) {
  const project = { id: 'qa-project', name: 'QA Project', files: [], chats: [] };
  const touched = [];
  const refreshed = [];
  const guard = (name) => new Proxy({}, { get(_t, prop) { touched.push(`${name}.${String(prop)}`); return () => { throw new Error(`${name} must not be used`); }; } });
  const workspace = { userId: 'qa-user', projects: [project], freeChats: [], revoked: false, assertActive() {}, pending: null,
    pendingStoreWrites() { return this.pending; }, refreshChatLists() { refreshed.push(this.pending === null ? 'settled' : 'early'); if (this.failRefresh) throw new Error('refresh failed'); } };
  const store = createProjectStore({
    fs, path, reasoningEffort: { validEffort: () => true }, projectAppearance: () => ({}), rag: guard('rag'),
    storageClient: guard('storageClient'), documentSources: { prune() {} }, authService: guard('authService'),
    currentWorkspace: () => workspace, PROJECTS: workspace.projects, FREE_CHATS: workspace.freeChats,
    sanitizeToolboxes: (b) => b, defaultToolboxes: () => ['core'], PROJECT_ROOT_FOLDER: 'root',
    createProjectFolder: async () => null, projectSweep: { afterDelete: async () => {} },
    ...(nativeTextWrite === undefined ? {} : { nativeTextWrite }),
  });
  return { store, project, touched, refreshed, workspace };
}

test('writeProjectTextFile with nativeTextWrite hands over the defined options, returns its file and touches nothing else', async () => {
  const calls = [];
  const saved = { name: 'qa-notes.md', content: 'x' };
  const { store, project, touched, refreshed } = storeWith(async (...args) => { calls.push(args); if (calls.length === 1) assert.equal(refreshed.length, 0, 'refresh comes after the write'); return saved; });
  const file = await store.writeProjectTextFile(project, 'qa-notes.md', 'body', { expectName: 'qa-notes.md', expectContent: undefined, adoptTo: null });
  assert.equal(file, saved);
  assert.deepEqual(calls, [['qa-user', 'qa-project', 'qa-notes.md', 'body', { expectName: 'qa-notes.md', adoptTo: null }]]);
  assert.equal(Object.hasOwn(calls[0][4], 'expectContent'), false);
  assert.equal(refreshed.length, 1);
  assert.deepEqual(touched, []);
  // No options at all: an empty object.
  await store.writeProjectTextFile(project, 'qa-two.md', 'b');
  assert.deepEqual(calls[1][4], {});
});

test('writeProjectTextFile with nativeTextWrite keeps core\'s source lock', async () => {
  const order = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const { store, project, refreshed } = storeWith(async (_u, _p, name) => {
    order.push(`start ${name}`);
    if (name === 'qa-first.md') await gate;
    if (name === 'qa-bad.md') throw new Error('refusal for the model');
    order.push(`end ${name}`);
    return { name };
  });
  const first = store.writeProjectTextFile(project, 'qa-first.md', 'a');
  const second = store.withSourceLock(project, async () => { order.push('other source operation'); });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, ['start qa-first.md']);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['start qa-first.md', 'end qa-first.md', 'other source operation']);
  assert.equal(refreshed.length, 1);
  await assert.rejects(store.writeProjectTextFile(project, 'qa-bad.md', 'b'), /refusal for the model/);
});

test('after a native write core takes the front\'s list in once its own queued saves settled, and a failed refresh is not the write\'s failure', async () => {
  let release;
  const { store, project, refreshed, workspace } = storeWith(async () => {
    workspace.pending = new Promise((r) => { release = () => { workspace.pending = null; r(); }; });
    setImmediate(() => release());
    return { name: 'qa.md' };
  });
  await store.writeProjectTextFile(project, 'qa.md', 't');
  assert.deepEqual(refreshed, ['settled']);
  workspace.failRefresh = true;
  const file = await store.writeProjectTextFile(project, 'qa.md', 't');
  assert.deepEqual(file, { name: 'qa.md' });
});

test('a write whose outcome is unknown says so (and still takes the list in); a refusal passes unchanged', async () => {
  const { store, project, refreshed } = storeWith(async (_u, _p, name) => {
    throw Object.assign(new Error(name === 'qa-gone.md' ? 'x' : 'refusal text'), { code: name === 'qa-gone.md' ? 'TEXT_WRITE_UNKNOWN' : 'TEXT_WRITE_REFUSED' });
  });
  await assert.rejects(store.writeProjectTextFile(project, 'qa-gone.md', 't', { expectName: 'Text/qa-gone.md' }),
    /^Error: The connection to noevia's project store failed while saving "Text\/qa-gone\.md".*Outcome unknown/);
  await assert.rejects(store.writeProjectTextFile(project, 'qa-other.md', 't'), /^Error: refusal text$/);
  assert.equal(refreshed.length, 2);
});

test('without nativeTextWrite (null or absent) writeProjectTextFile takes its own path', async () => {
  for (const dep of [null, undefined]) {
    const { store, project, refreshed } = storeWith(dep);
    // The own path validates the upload (the wasm upload check, which a bare checkout may not
    // have: "upload could not be checked") and then asks the account's storage connection (the
    // stand-in refuses). Either way it is core's own code that answers, and the front's
    // refresh is never called. The full old path is covered by project-create-files-687.test.cjs.
    await assert.rejects(store.writeProjectTextFile(project, 'qa-notes.md', 'body'), /upload could not be checked|authService must not be used/);
    assert.equal(refreshed.length, 0);
  }
});
