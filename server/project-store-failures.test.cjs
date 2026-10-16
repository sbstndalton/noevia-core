'use strict';
// sbstndalton/noevia#1914-#1917 (review of #1264's project store): what a failed store save must
// not do. The real workspace store, project store and routes, over a stand-in for the Rust store
// (tests/server/project-store-stub.cjs) whose writes can be made to fail. Synthetic data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const psc = require('./project-store-client.cjs');
const http = require('./http.cjs');
const { createWorkspaceStore } = require('./workspace.cjs');
const { createProjectStore } = require('./projects.cjs');
const { createProjectRoutes } = require('./routes/projects.cjs');
const { createChatListRoutes } = require('./routes/chat-lists.cjs');
const { createStubStore } = require('../tests/server/project-store-stub.cjs');

const USER = '11111111-2222-4333-8444-555555555555';
const DEFAULT = { id: 'local', label: 'Local', baseUrl: '', apiKey: '' };

/** A stub store whose writes fail (PROJECTS_BUSY) while `fail(file)` says so. */
function failingStub(root) {
  const stub = createStubStore(root);
  const state = { fail: () => false };
  const write = stub.write;
  stub.write = async (user, file, ...rest) => { if (state.fail(file)) throw psc.busy(); return write(user, file, ...rest); };
  return { stub, state };
}

function harness({ projects = [], free = [], rag = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'store-failures-'));
  const dir = path.join(root, 'users', USER);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify({ projects }, null, 2));
  fs.writeFileSync(path.join(dir, 'free-chats.json'), JSON.stringify(free, null, 2));
  const { stub, state } = failingStub(root);
  const wsStore = createWorkspaceStore(root, DEFAULT, null, { rustProjects: true, rustFreeChats: true, projectStore: stub });
  const scope = new AsyncLocalStorage();
  const currentWorkspace = () => scope.getStore().workspace;
  const proxy = (field) => new Proxy([], {
    get(_t, prop) { const v = currentWorkspace()[field][prop]; return typeof v === 'function' ? v.bind(currentWorkspace()[field]) : v; },
    set(_t, prop, v) { currentWorkspace()[field][prop] = v; return true; },
    ownKeys() { return Reflect.ownKeys(currentWorkspace()[field]); },
    getOwnPropertyDescriptor(_t, prop) { return Reflect.getOwnPropertyDescriptor(currentWorkspace()[field], prop); },
    has(_t, prop) { return prop in currentWorkspace()[field]; },
  });
  const PROJECTS = proxy('projects'), FREE_CHATS = proxy('freeChats');
  const store = createProjectStore({
    fs, path, currentWorkspace, PROJECTS, FREE_CHATS, sanitizeToolboxes: () => null, defaultToolboxes: () => ['core'],
    reasoningEffort: {}, projectAppearance: () => ({}), rag: { deleteProjectFile() {}, ...rag }, storageClient: { isBrowsable: () => false }, documentSources: { prune() {}, directory: (w, id) => path.join(w.dir, 'docs', id) },
    authService: { getStorage: () => ({ kind: 'local' }) }, PROJECT_ROOT_FOLDER: 'Projects', createProjectFolder: async () => null, projectSweep: { afterDelete: async () => [] },
  });
  const projectRoutes = createProjectRoutes({ json: http.json, readBody: http.readBody, readJson: http.readJson, store, PROJECTS, currentWorkspace, DEFAULT_TOOLBOXES: ['core'], diaryExtras: require('./diary-extras.cjs'), fs, path });
  const chatRoutes = createChatListRoutes({ json: http.json, readBody: http.readBody, currentWorkspace, PROJECTS, FREE_CHATS, diaryExtras: { internalProject: () => false }, crypto: require('node:crypto'),
    STORED_HISTORY_BYTES: 1, STORED_HISTORY_CAP: 1, chatLists: () => ({ freeChats: [], projects: [] }), removeChat: () => false, store });
  /** One request as index.cjs runs it: its saves counted, its answer held. */
  async function call(method, p) {
    const saves = [];
    let status = null, body = null;
    const res = { headers: {}, setHeader() {}, hasHeader: () => false, removeHeader() {}, writeHead(s) { status = s; }, write() {}, end(v) { body = v; } };
    let ended;
    const done = new Promise((r) => { ended = r; });
    const realEnd = res.end; res.end = (v) => { realEnd(v); ended(); };
    psc.holdForStoreSaves(res, saves);
    const ws = wsStore.get(USER);
    const wsWithHook = ws;
    await scope.run({ workspace: wsWithHook }, async () => {
      const save = ws.storeSaved.bind(ws);
      ws.storeSaved = (promise, name) => { const p2 = save(promise, name); saves.push(p2); return p2; };
      const request = { method, headers: {}, async *[Symbol.asyncIterator]() {} };
      const ctx = { path: p, authn: { user: { id: USER, role: 'admin' } }, url: new URL(`http://h${p}`) };
      try {
        if (!(await projectRoutes(request, res, ctx)) && !(await chatRoutes(request, res, ctx))) throw Error(`${p}: not handled`);
      } catch (err) { const f = http.errorResponse(err); http.json(res, f.status, f.body); }
      ws.storeSaved = save;
    });
    await done;
    return { status, body: JSON.parse(body) };
  }
  return { root, dir, wsStore, stub, state, store, scope, call };
}

const history = (h, id) => path.join(h.dir, `history-${id}.json`);
const tombstones = (h) => { try { return JSON.parse(fs.readFileSync(path.join(h.dir, 'deleted-chats.json'), 'utf8')); } catch { return []; } };

test('#1914: store busy -> DELETE a project chat answers 503, keeps its transcript and takes the tombstone back', async () => {
  const h = harness({ projects: [{ id: 'p1', name: 'P', chats: [{ id: 'c1', title: 'T' }], instructionSkills: {} }] });
  fs.writeFileSync(history(h, 'c1'), '[{"role":"user","content":"synthetic"}]');
  h.state.fail = () => true;
  const r = await h.call('DELETE', '/api/projects/p1/chats/c1');
  assert.equal(r.status, 503);
  assert.equal(r.body.code, 'PROJECTS_BUSY');
  assert.ok(fs.existsSync(history(h, 'c1')), 'the transcript is still there');
  assert.ok(!tombstones(h).includes('c1'), 'the tombstone was taken back');
  assert.deepEqual(h.wsStore.get(USER).projects[0].chats.map((c) => c.id), ['c1'], 'a fresh read shows the chat');
  // The control: with the store answering, the delete removes the transcript.
  h.state.fail = () => false;
  const ok = await h.call('DELETE', '/api/projects/p1/chats/c1');
  assert.equal(ok.status, 200);
  assert.ok(!fs.existsSync(history(h, 'c1')));
  assert.ok(tombstones(h).includes('c1'));
});

test('#1914: store busy -> DELETE a free chat answers 503 and keeps its transcript', async () => {
  const h = harness({ free: [{ id: 'f1', title: 'F', updatedAt: 1 }] });
  fs.writeFileSync(history(h, 'f1'), '[]');
  h.state.fail = (file) => file === 'free-chats.json';
  const r = await h.call('DELETE', '/api/freechats/f1');
  assert.equal(r.status, 503);
  assert.ok(fs.existsSync(history(h, 'f1')));
  assert.ok(!tombstones(h).includes('f1'));
  assert.deepEqual(h.wsStore.get(USER).freeChats.map((c) => c.id), ['f1']);
});

test('#1914: store busy -> DELETE a project answers 503 and keeps its RAG index and chats', async () => {
  const h = harness({ projects: [{ id: 'p1', name: 'P', chats: [{ id: 'c1', title: 'T' }], instructionSkills: {} }] });
  const ragDir = path.join(h.dir, 'rag');
  fs.mkdirSync(ragDir, { recursive: true });
  fs.writeFileSync(path.join(ragDir, 'p1.db'), 'synthetic index');
  fs.writeFileSync(history(h, 'c1'), '[]');
  h.state.fail = () => true;
  const r = await h.call('DELETE', '/api/projects/p1');
  assert.equal(r.status, 503);
  assert.ok(fs.existsSync(path.join(ragDir, 'p1.db')), 'the RAG index is still there');
  assert.ok(fs.existsSync(history(h, 'c1')), "its chats' transcripts too");
  assert.deepEqual(h.wsStore.get(USER).projects.map((p) => p.id), ['p1']);
  h.state.fail = () => false;
  assert.equal((await h.call('DELETE', '/api/projects/p1')).status, 200);
  assert.ok(!fs.existsSync(path.join(ragDir, 'p1.db')));
});

test('#1915: a separately queued save of the other file behind a failed one never writes', async () => {
  const h = harness({ projects: [{ id: 'p1', chats: [], instructionSkills: {} }] });
  h.state.fail = (file) => file === 'projects.json';
  const ws = h.wsStore.get(USER);
  ws.projects.push({ id: 'p2', chats: [], instructionSkills: {} });
  const first = ws.saveProjects();
  ws.freeChats.push({ id: 'f-lost', updatedAt: 1 });
  const second = ws.saveFreeChats(); // its own queue key: not the `waiting` dedup
  await assert.rejects(first, (e) => e.code === 'PROJECTS_BUSY');
  await assert.rejects(second, (e) => e.code === 'PROJECTS_BUSY');
  assert.deepEqual(h.stub.writes, [], 'nothing of the failed view was written');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.dir, 'free-chats.json'), 'utf8')), []);
});

test('#1916: the store secret leaves process.env as soon as the client is made; git gets a minimal env', () => {
  const env = { NOEVIA_PROJECT_STORE_PORT: '19021', NOEVIA_PROJECT_STORE_TOKEN: 'synthetic-store-token-0123456789abcdef', PATH: '/usr/bin' };
  const client = psc.clientFromEnv(env);
  assert.equal(typeof client.write, 'function');
  assert.equal('NOEVIA_PROJECT_STORE_TOKEN' in env, false);
  const { gitEnv } = require('./code-workspace.cjs');
  const out = gitEnv({ GIT_AUTHOR_NAME: 'Synthetic' }, { PATH: '/usr/bin', HOME: '/home/x', NOEVIA_PROJECT_STORE_TOKEN: 'x', OPENAI_API_KEY: 'x', SECRET: 'x' });
  assert.deepEqual(out, { PATH: '/usr/bin', HOME: '/home/x', GIT_AUTHOR_NAME: 'Synthetic' });
});

test('#1917: an indexing outcome that lands after a failed save is recorded on the view read again', async () => {
  let finish;
  const h = harness({ projects: [{ id: 'p1', chats: [], files: [{ name: 'a.md', content: 'synthetic text', document: { indexing: 'pending' } }], instructionSkills: {} }],
    rag: { indexProjectFile: () => new Promise((r) => { finish = r; }) } });
  const ws = h.wsStore.get(USER);
  h.scope.run({ workspace: ws }, () => h.store.indexSource(ws.projects[0], ws.projects[0].files[0]));
  // A save fails meanwhile: this view is dropped.
  h.state.fail = () => true;
  ws.projects[0].name = 'lost';
  await assert.rejects(ws.saveProjects());
  h.state.fail = () => false;
  finish({ ok: true, embedded: 1, stored: 1 });
  await new Promise((r) => setTimeout(r, 50));
  await h.wsStore.get(USER).pendingStoreWrites();
  const disk = JSON.parse(fs.readFileSync(path.join(h.dir, 'projects.json'), 'utf8')).projects[0];
  assert.equal(disk.files[0].document.indexing, 'ready');
  assert.equal(disk.name, undefined, 'the failed change did not come back');
});

test('#1917: the backfill\'s next pass gets the view read again, and its save goes through', async () => {
  const h = harness({ projects: [{ id: 'p1', chats: [], instructionSkills: {} }] });
  const old = h.wsStore.get(USER);
  h.state.fail = () => true;
  old.projects[0].mark = 'lost';
  await assert.rejects(old.saveProjects());
  h.state.fail = () => false;
  await assert.rejects(old.saveProjects(), 'the dropped view stays failed');
  const next = h.wsStore.get(USER); // what workspaceFor(userId) answers on the next pass
  assert.notEqual(next, old);
  assert.equal(old.current(), next);
  next.projects[0].searchable = 'covered';
  await next.saveProjects();
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.dir, 'projects.json'), 'utf8')).projects[0].searchable, 'covered');
});

test('#1917: a chat turn\'s generated title is applied again to the view read after its save failed', async () => {
  const first = 'plan a picnic for saturday';
  const h = harness({ free: [{ id: 'f1', title: first, updatedAt: 1 }] });
  let failures = 1;
  h.state.fail = (file) => file === 'free-chats.json' && failures-- > 0;
  const ws = h.wsStore.get(USER);
  const applied = h.scope.run({ workspace: ws }, () => h.store.setChatTitle(null, 'f1', 'Picnic Plan', first));
  assert.equal(applied, true);
  await new Promise((r) => setTimeout(r, 50));
  await h.wsStore.get(USER).pendingStoreWrites();
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.dir, 'free-chats.json'), 'utf8'))[0].title, 'Picnic Plan');
  // And the routing flags the same way.
  failures = 1;
  h.scope.run({ workspace: h.wsStore.get(USER) }, () => h.store.setChatFlags(null, 'f1', { forceLocal: true }));
  await new Promise((r) => setTimeout(r, 50));
  await h.wsStore.get(USER).pendingStoreWrites();
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.dir, 'free-chats.json'), 'utf8'))[0].forceLocal, true);
});
