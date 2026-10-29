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
  const state = { fail: () => false, gate: null };
  const write = stub.write;
  stub.write = async (user, file, ...rest) => { if (state.gate) await state.gate; if (state.fail(file)) throw psc.busy(); return write(user, file, ...rest); };
  return { stub, state };
}

function harness({ projects = [], free = [], rag = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'store-failures-'));
  const dir = path.join(root, 'users', USER);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify({ projects }, null, 2));
  fs.writeFileSync(path.join(dir, 'free-chats.json'), JSON.stringify(free, null, 2));
  const { stub, state } = failingStub(root);
  const wsStore = createWorkspaceStore(root, DEFAULT, null, { projectStore: stub });
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
  const ragDeletes = [];
  const ragImpl = { deleteProjectFile: (pid, name) => ragDeletes.push(`${pid}/${name}`), indexProjectFile: async () => ({ ok: true, embedded: 0, stored: 0 }), ...rag };
  const store = createProjectStore({
    fs, path, currentWorkspace, PROJECTS, FREE_CHATS, sanitizeToolboxes: () => null, defaultToolboxes: () => ['core'],
    reasoningEffort: {}, projectAppearance: () => ({}), rag: ragImpl, storageClient: { isBrowsable: () => false }, documentSources: { prune() {}, directory: (w, id) => path.join(w.dir, 'docs', id) },
    authService: { getStorage: () => ({ kind: 'local' }) }, PROJECT_ROOT_FOLDER: 'Projects', createProjectFolder: async () => null, projectSweep: { afterDelete: async () => [] },
  });
  const projectRoutes = createProjectRoutes({ rag: ragImpl, projectAppearance: () => ({}), reasoningEffort: { validEffort: () => true }, json: http.json, readBody: http.readBody, readJson: http.readJson, store, PROJECTS, currentWorkspace, DEFAULT_TOOLBOXES: ['core'], diaryExtras: require('./diary-extras.cjs'), fs, path });
  const chatRoutes = createChatListRoutes({ json: http.json, readBody: http.readBody, currentWorkspace, PROJECTS, FREE_CHATS, diaryExtras: { internalProject: () => false }, crypto: require('node:crypto'),
    STORED_HISTORY_BYTES: 1, STORED_HISTORY_CAP: 1, chatLists: () => ({ freeChats: [], projects: [] }), removeChat: () => false, store });
  /** One request as index.cjs runs it: its saves counted, its answer held. */
  async function call(method, p, reqBody = null) {
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
      const request = { method, headers: {}, async *[Symbol.asyncIterator]() { if (reqBody !== null) yield Buffer.from(JSON.stringify(reqBody)); } };
      const ctx = { path: p, authn: { user: { id: USER, role: 'admin' } }, url: new URL(`http://h${p}`) };
      try {
        if (!(await projectRoutes(request, res, ctx)) && !(await chatRoutes(request, res, ctx))) throw Error(`${p}: not handled`);
      } catch (err) { const f = http.errorResponse(err); http.json(res, f.status, f.body); }
      ws.storeSaved = save;
    });
    await done;
    return { status, body: JSON.parse(body) };
  }
  return { root, dir, wsStore, stub, state, store, scope, call, ragDeletes };
}

const history = (h, id) => path.join(h.dir, `history-${id}.json`);
const tombstones = (h) => { try { return JSON.parse(fs.readFileSync(path.join(h.dir, 'deleted-chats.json'), 'utf8')); } catch { return []; } };

// #1071 slice 6: a chat's delete is the Rust store's one operation (its own tests cover the list
// save failing after the tombstone, which takes it back). Node's own deletes (the retention sweep)
// call it and keep its error; Node's routes no longer answer the delete.
const asUser = (h, fn) => h.scope.run({ workspace: h.wsStore.get(USER) }, fn);

test('#1914/#1071: a busy store rejects Node\'s chat delete with PROJECTS_BUSY and Node changes nothing', async () => {
  const h = harness({ projects: [{ id: 'p1', name: 'P', chats: [{ id: 'c1', title: 'T' }], instructionSkills: {} }], free: [{ id: 'f1', title: 'F', updatedAt: 1 }] });
  fs.writeFileSync(history(h, 'c1'), '[{"role":"user","content":"synthetic"}]');
  fs.writeFileSync(history(h, 'f1'), '[]');
  const real = h.stub.chatDelete;
  h.stub.chatDelete = async () => { throw psc.busy(); };
  await assert.rejects(asUser(h, () => h.store.deleteChat('p1', 'c1')), (e) => e.code === 'PROJECTS_BUSY' && e.status === 503);
  await assert.rejects(asUser(h, () => h.store.deleteFreeChat('f1')), (e) => e.code === 'PROJECTS_BUSY');
  assert.ok(fs.existsSync(history(h, 'c1')) && fs.existsSync(history(h, 'f1')), 'the transcripts are still there');
  assert.deepEqual(tombstones(h), []);
  assert.deepEqual(h.wsStore.get(USER).projects[0].chats.map((c) => c.id), ['c1']);
  assert.deepEqual(h.wsStore.get(USER).freeChats.map((c) => c.id), ['f1']);
  // The control: with the store answering, the store removes it all and Node's view follows.
  h.stub.chatDelete = real;
  const writesBefore = [...h.stub.writes];
  assert.equal(await asUser(h, () => h.store.deleteChat('p1', 'c1')), true);
  assert.equal(await asUser(h, () => h.store.deleteFreeChat('f1')), true);
  assert.ok(!fs.existsSync(history(h, 'c1')) && !fs.existsSync(history(h, 'f1')));
  assert.deepEqual(tombstones(h), ['c1', 'f1']);
  assert.deepEqual(h.wsStore.get(USER).projects[0].chats, []);
  assert.deepEqual(h.wsStore.get(USER).freeChats, []);
  assert.deepEqual(h.stub.writes, writesBefore, 'Node wrote neither list itself: the store did');
});

test('#1071 slice 6: Node\'s routes no longer answer a chat\'s delete', async () => {
  const h = harness({ projects: [{ id: 'p1', name: 'P', chats: [{ id: 'c1', title: 'T' }], instructionSkills: {} }], free: [{ id: 'f1', title: 'F', updatedAt: 1 }] });
  fs.writeFileSync(history(h, 'c1'), '[]');
  for (const p of ['/api/projects/p1/chats/c1', '/api/freechats/f1']) {
    const r = await h.call('DELETE', p);
    assert.equal(r.status, 500, `${p}: not handled by these mounts (index.cjs refuses it first, 503)`);
  }
  assert.ok(fs.existsSync(history(h, 'c1')));
  assert.deepEqual(tombstones(h), []);
});

// #1914 for a project's DELETE moved with the route (#2191 round 2): noevia-rs tests/project_lifecycle.rs
// `a_failed_save_removes_nothing`. The store's deleteProject (a chat's attachments project) keeps it here.
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

test('#1919: a deferred index removal spares a source of the same name uploaded again meanwhile', async () => {
  const files = [{ name: 'a.md', content: 'old text' }];
  for (const reupload of [true, false]) {
    const h = harness({ projects: [{ id: 'p1', name: 'P', chats: [], files: JSON.parse(JSON.stringify(files)), instructionSkills: {} }] });
    let release;
    h.state.gate = new Promise((r) => { release = r; });
    const pending = h.call('POST', '/api/projects/p1/config', { files: [] });
    await new Promise((r) => setTimeout(r, 30)); // the route has saved; the write waits at the gate
    if (reupload) h.wsStore.get(USER).projects[0].files.push({ name: 'a.md', content: 'new text' });
    h.state.gate = null; release();
    const answered = await pending;
    assert.equal(answered.status, 200);
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(h.ragDeletes.filter((d) => d === 'p1/a.md'), reupload ? [] : ['p1/a.md'], reupload ? 'kept for the re-upload' : 'removed when nothing replaced it');
  }
});

test('#1919: a background writer stops on an account removed meanwhile, and never makes its directory again', async () => {
  let finish;
  const h = harness({ projects: [{ id: 'p1', chats: [], files: [{ name: 'a.md', content: 'synthetic', document: { indexing: 'pending' } }], instructionSkills: {} }],
    rag: { indexProjectFile: () => new Promise((r) => { finish = r; }) } });
  const ws = h.wsStore.get(USER);
  h.scope.run({ workspace: ws }, () => h.store.indexSource(ws.projects[0], ws.projects[0].files[0]));
  h.state.fail = () => true;
  await assert.rejects(ws.saveProjects()); // the view is dropped
  fs.rmSync(h.dir, { recursive: true, force: true }); // the Rust front deletes the account
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    assert.throws(() => ws.current(), (e) => e.status === 410);
    finish({ ok: true, embedded: 1, stored: 1 });
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(unhandled, []);
    assert.equal(fs.existsSync(h.dir), false, 'users/<id>/ was not made again');
  } finally { process.off('unhandledRejection', onUnhandled); }
});


test('#1920: a change made while a store write is awaited is not lost', async () => {
  const h = harness({ projects: [{ id: 'p1', name: 'P', chats: [], instructionSkills: {} }] });
  const ws = h.wsStore.get(USER);
  let release;
  h.state.gate = new Promise((r) => { release = r; });
  ws.projects[0].name = 'First'; // merged as "ours": `written` holds this very object
  const first = ws.saveProjects();
  await new Promise((r) => setTimeout(r, 20)); // read and merged; the write waits at the gate
  ws.projects[0].name = 'Second'; // changed while the write is awaited
  const second = ws.saveProjects();
  h.state.gate = null; release();
  await Promise.all([first, second]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.dir, 'projects.json'), 'utf8')).projects[0].name, 'Second');
  assert.equal(h.wsStore.get(USER).projects[0].name, 'Second');
});
