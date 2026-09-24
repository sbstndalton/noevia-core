'use strict';
// The project routes against a fake store: what is left alone, what is refused and with which
// words, and that a background source job re-enters the router with the same headers. The
// store is projects.test.cjs; uploads end to end are document-routes.test.cjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const { createProjectRoutes, DOCUMENT_UPLOAD_CAP } = require('./projects.cjs');

function fixture({ projects = [], diary = true } = {}) {
  const sent = [];
  const dispatched = [];
  const requestScope = new AsyncLocalStorage();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-project-routes-'));
  const store = {
    getProject: (id) => projects.find((p) => p.id === id) || null,
    saveProjects: () => { store.saves += 1; }, saves: 0,
    createProject: async (body) => { if (!body.name) throw Object.assign(Error('name required'), { status: 400 }); const p = { id: 'proj-new', ...body }; projects.unshift(p); return p; },
    pruneDocuments() {}, sweepDeletedProject() {}, withSourceLock: (_p, op) => op(), ensureProjectFolder: async () => null, indexSource() {},
    ownsFile: () => false, loadChats: (id) => (store.getProject(id) || { chats: [] }).chats || [], saveChats: (id, chats) => { store.savedChats = [id, chats]; },
    deleteChat: (id, chatId) => id === 'p1' && chatId === 'c1',
  };
  const routes = createProjectRoutes({
    json: (res, status, body) => { sent.push({ status, body }); },
    readBody: async (req) => { let s = ''; for await (const c of req) s += c; return s; },
    readJson: require('../http.cjs').readJson,
    requestScope,
    dispatch: async (req, res) => { dispatched.push({ url: req.url, method: req.method, headers: req.headers, progress: requestScope.getStore()?.sourceProgress }); res.writeHead(200); res.end('{"ok":true}'); },
    currentWorkspace: () => ({ dir, userId: 'u1', ragDir: () => path.join(dir, 'rag'), assetDir: () => path.join(dir, 'assets') }),
    authService: { diaryEnabled: () => diary, getStorage: () => ({ kind: 'local' }) },
    storageClient: { isBrowsable: () => false, TEXT_EXTENSIONS: new Set(['.txt']), safeRelativePath: (f) => f },
    documents: { isDocument: (name) => /\.pdf$/i.test(name) },
    documentSources: {}, rag: { deleteProjectFile() {} },
    fs, path,
    reasoningEffort: { validEffort: (e) => ['default', 'low', 'high'].includes(e) },
    projectAppearance: () => ({}),
    diaryExtras: { PROJECT_ID: 'diary-extras', chatProjectId: (id) => (id === 'bad' ? null : `chat-${id}`), newProject: () => ({ id: 'diary-extras', name: 'Diary' }) },
    PROJECTS: projects, DEFAULT_TOOLBOXES: ['core'], sanitizeToolboxes: (b) => (Array.isArray(b) ? b : null),
    getProvider: (id) => (id === 'default' ? {} : null), ensureRolesLoaded() {},
    store,
  });
  const call = (method, path, body, search = '') => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
    Object.assign(req, { method, url: path + search, headers: { cookie: 'session=x' }, socket: {} });
    return routes(req, { writeHead() {}, end() {} }, { path, authn: { user: { id: 'u1', role: 'member' } }, url: new URL(`http://localhost${path}${search}`) });
  };
  return { call, sent, dispatched, store, projects };
}

test('paths and methods outside the project surface fall through', async () => {
  const f = fixture({ projects: [{ id: 'p1', chats: [], assets: [{ id: 'a' }] }] });
  assert.equal(await f.call('GET', '/api/workspace'), false);
  assert.equal(await f.call('GET', '/api/projects'), false, 'the list is served by /api/workspace');
  assert.equal(await f.call('PUT', '/api/projects/p1/chats'), false, 'an unhandled method keeps falling through');
  assert.equal(await f.call('PATCH', '/api/projects/p1/assets/a'), false);
  assert.equal(f.sent.length, 0);
});

test('creating and deleting a project keeps the original status codes and messages', async () => {
  const f = fixture();
  assert.equal(await f.call('POST', '/api/projects', '{oops'), true);
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'invalid JSON' } });
  await f.call('POST', '/api/projects', {});
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'name required' } });
  await f.call('POST', '/api/projects', { name: 'New' });
  assert.equal(f.sent.pop().status, 200);
  await f.call('DELETE', '/api/projects/missing');
  assert.deepEqual(f.sent.pop(), { status: 404, body: { error: 'no such project' } });
  await f.call('DELETE', '/api/projects/proj-new');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { ok: true } });
  assert.deepEqual(f.projects, []);
});

test('the config patch validates each field with the same words as before', async () => {
  const f = fixture({ projects: [{ id: 'p1', files: [] }] });
  await f.call('POST', '/api/projects/p1/config', { routing: 'sometimes' });
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: "routing must be 'auto' or 'manual'" } });
  await f.call('POST', '/api/projects/p1/config', { provider: 'ghost' });
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'no such provider' } });
  await f.call('POST', '/api/projects/p1/config', { toolboxes: 'core' });
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'toolboxes must be an array of toolbox ids' } });
  await f.call('POST', '/api/projects/p1/config', { reasoningEffort: 'max' });
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'Invalid reasoning effort' } });
  await f.call('POST', '/api/projects/nope/config', {});
  assert.deepEqual(f.sent.pop(), { status: 404, body: { error: 'no such project' } });
  await f.call('POST', '/api/projects/p1/config', { name: ' Renamed ', pinned: true, memories: ['  keep ', 7] });
  assert.deepEqual(f.sent.pop(), { status: 200, body: { ok: true } });
  assert.equal(f.projects[0].name, 'Renamed');
  assert.equal(f.projects[0].pinned, true);
  assert.deepEqual(f.projects[0].memories, ['keep']);
  assert.equal(f.store.saves, 1);
});

test('chat metas: listing, saving a normalized list and deleting one', async () => {
  const f = fixture({ projects: [{ id: 'p1', chats: [{ id: 'c1', title: 'one' }] }] });
  await f.call('GET', '/api/projects/p1/chats');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { chats: [{ id: 'c1', title: 'one' }] } });
  await f.call('POST', '/api/projects/p1/chats', { chats: [{ id: 'c 2!', updatedAt: 'later' }, { title: 'no id' }] });
  assert.deepEqual(f.sent.pop(), { status: 200, body: { ok: true } });
  assert.equal(f.store.savedChats[0], 'p1');
  assert.equal(f.store.savedChats[1].length, 1);
  assert.equal(f.store.savedChats[1][0].id, 'c2');
  assert.equal(f.store.savedChats[1][0].title, 'New task');
  assert.equal(typeof f.store.savedChats[1][0].updatedAt, 'number');
  await f.call('POST', '/api/projects/p1/chats', { chats: 'x' });
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'chats array required' } });
  await f.call('DELETE', '/api/projects/p1/chats/c1');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { ok: true } });
  await f.call('DELETE', '/api/projects/p1/chats/c9');
  assert.deepEqual(f.sent.pop(), { status: 404, body: { error: 'no such chat' } });
});

test('uploads refuse what they always refused', async () => {
  const f = fixture({ projects: [{ id: 'p1', files: [] }] });
  await f.call('POST', '/api/projects/p1/upload', { name: '' });
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'a filename is required' } });
  await f.call('POST', '/api/projects/p1/upload', { name: 'photo.png' });
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'photo.png is not a supported source (text file or PDF).' } });
  await f.call('POST', '/api/projects/p1/upload', { name: 'notes.txt', dataBase64: '' });
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'file was empty' } });
  await f.call('POST', '/api/projects/p1/documents', { name: 'notes.txt' });
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'notes.txt is not a supported document (PDF).' } });
  await f.call('POST', '/api/projects/p1/assets', { name: 'a', mime: 'image/bmp' });
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'image/bmp is not a supported image (png, jpeg, webp or gif).' } });
  await f.call('DELETE', '/api/projects/p1/files', { path: 'Elsewhere/x.txt' });
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'That file is not in any folder attached to this project, so it cannot be deleted from here.' } });
  assert.equal(DOCUMENT_UPLOAD_CAP, 25 * 1024 * 1024);
});

test('a background source job re-enters the router with the caller\'s headers and a progress hook', async () => {
  const f = fixture({ projects: [{ id: 'p1', files: [] }] });
  assert.equal(await f.call('POST', '/api/projects/p1/upload', { name: 'x.txt' }, '?background=1'), true);
  const reply = f.sent.pop();
  assert.equal(reply.status, 202);
  assert.match(reply.body.poll, /^\/api\/projects\/p1\/source-jobs\//);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(f.dispatched.length, 1);
  assert.equal(f.dispatched[0].url, '/api/projects/p1/upload');
  assert.equal(f.dispatched[0].headers.cookie, 'session=x');
  assert.equal(typeof f.dispatched[0].progress, 'function');
  await f.call('POST', '/api/projects/ghost/upload', { name: 'x.txt' }, '?background=1');
  assert.deepEqual(f.sent.pop(), { status: 404, body: { error: 'project not found' } });
});

test('chat attachments and the Diary context are created on POST and only read on GET', async () => {
  const f = fixture({ diary: false });
  await f.call('GET', '/api/chats/bad/context');
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'Invalid chat identifier' } });
  await f.call('GET', '/api/chats/abc/context');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { project: null } });
  await f.call('POST', '/api/chats/abc/context');
  assert.equal(f.sent.pop().body.project.id, 'chat-abc');
  await f.call('POST', '/api/diary/context');
  assert.deepEqual(f.sent.pop(), { status: 404, body: { error: 'Diary add-on is disabled' } });
});


test('malformed background source JSON is 400 before any job is dispatched', async () => {
  const f = fixture({ projects: [{ id: 'p1' }] });
  for (const suffix of ['upload', 'documents', 'sources/sync']) {
    await assert.rejects(f.call('POST', `/api/projects/p1/${suffix}`, '{broken', '?background=1'),
      { status: 400, message: 'invalid JSON' });
  }
  assert.deepEqual(f.dispatched, []);
});

test('a project id from another tenant 404s on the upload path: getProject reads only the current workspace (#116)', async () => {
  const { createProjectStore } = require('../projects.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-tenant-'));
  const mk = (userId) => ({ dir: path.join(root, userId), userId, projects: [], freeChats: [], saveProjects() {}, saveFreeChats() {}, historyPath: (id) => path.join(root, userId, `h-${id}.json`), assetDir: (id) => path.join(root, userId, 'assets', id), ragDir: () => path.join(root, userId, 'rag') });
  const tenants = { alice: mk('alice'), bob: mk('bob') };
  tenants.bob.projects.push({ id: 'proj-bob', name: 'Bob only', files: [], chats: [] });
  tenants.alice.projects.push({ id: 'proj-alice', name: 'Alice', files: [], chats: [] });
  const scope = new AsyncLocalStorage();
  const currentWorkspace = () => tenants[scope.getStore().user];
  // The same request-scoped array view index.cjs builds (arrayProxy).
  const view = (field) => new Proxy([], {
    get(_t, prop) { const v = currentWorkspace()[field][prop]; return typeof v === 'function' ? v.bind(currentWorkspace()[field]) : v; },
    set(_t, prop, v) { currentWorkspace()[field][prop] = v; return true; },
    ownKeys() { return Reflect.ownKeys(currentWorkspace()[field]); },
    getOwnPropertyDescriptor() { return { enumerable: true, configurable: true }; },
  });
  const PROJECTS = view('projects');
  const store = createProjectStore({ fs, path, reasoningEffort: {}, projectAppearance: () => ({}), rag: {}, storageClient: { isBrowsable: () => false }, documentSources: {}, authService: {},
    currentWorkspace, PROJECTS, FREE_CHATS: view('freeChats'), sanitizeToolboxes: () => null, defaultToolboxes: () => [], PROJECT_ROOT_FOLDER: 'x', createProjectFolder: async () => null, projectSweep: {} });
  const sent = [];
  let touchedLock = false;
  const routes = createProjectRoutes({
    json: (_res, status, body) => { sent.push({ status, body }); }, readBody: async () => '{}', readJson: async () => ({}), requestScope: scope, dispatch: async () => {},
    currentWorkspace, authService: { getStorage: () => ({ kind: 'local' }) }, storageClient: { isBrowsable: () => false, TEXT_EXTENSIONS: new Set(['.txt']) }, documents: { isDocument: () => false },
    documentSources: {}, rag: {}, fs, path, reasoningEffort: {}, projectAppearance: () => ({}), diaryExtras: { chatProjectId: () => null }, PROJECTS, DEFAULT_TOOLBOXES: [], sanitizeToolboxes: () => null,
    getProvider: () => null, ensureRolesLoaded() {}, store: { ...store, withSourceLock: (...a) => { touchedLock = true; return store.withSourceLock(...a); } },
  });
  const upload = (user, id) => scope.run({ user }, () => {
    const p = `/api/projects/${id}/upload`;
    const req = Readable.from([Buffer.from(JSON.stringify({ name: 'n.txt', dataBase64: Buffer.from('synthetic').toString('base64'), organized: true }))]);
    Object.assign(req, { method: 'POST', url: p, headers: {}, socket: {} });
    return routes(req, { writeHead() {}, end() {} }, { path: p, authn: { user: { id: user } }, url: new URL(`http://localhost${p}`) });
  });
  try {
    await upload('alice', 'proj-bob');
    assert.deepEqual(sent.pop(), { status: 404, body: { error: 'no such project' } });
    assert.equal(touchedLock, false, 'no source lock or write was attempted for a foreign project');
    assert.deepEqual(tenants.bob.projects[0].files, [], 'the other tenant\'s project is untouched');
    scope.run({ user: 'bob' }, () => assert.equal(store.getProject('proj-bob').name, 'Bob only'));
    scope.run({ user: 'alice' }, () => assert.equal(store.getProject('proj-bob'), null));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
