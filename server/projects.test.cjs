'use strict';
// The project store with a fake workspace: what createProject refuses, how chat metas and
// tombstones move together, and which files a project may delete. The HTTP surface is
// routes/projects.test.cjs; the end-to-end paths stay in document-routes.test.cjs and friends.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createProjectStore } = require('./projects.cjs');

function fixture({ browsable = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-projects-'));
  const workspace = {
    dir, userId: 'u1', projects: [], freeChats: [],
    saved: 0, savedFree: 0,
    saveProjects() { this.saved += 1; }, saveFreeChats() { this.savedFree += 1; },
    historyPath: (id) => path.join(dir, `${id}.json`),
    assetDir: (id) => path.join(dir, 'assets', id),
  };
  const indexed = [], deleted = [], swept = [];
  const store = createProjectStore({
    fs, path,
    reasoningEffort: { validEffort: (e) => ['default', 'low', 'high'].includes(e) },
    projectAppearance: (body) => (body.icon === 'bad' ? (() => { throw new Error('unknown icon'); })() : { icon: body.icon || 'folder' }),
    rag: { indexProjectFile: async (...args) => { indexed.push(args); return { ok: true, stored: 1, embedded: 1 }; }, deleteProjectFile: (...args) => deleted.push(args) },
    storageClient: { isBrowsable: () => browsable },
    documentSources: { prune() {}, directory: () => path.join(dir, 'docs') },
    authService: { getStorage: () => ({ kind: browsable ? 'webdav' : 'local' }) },
    currentWorkspace: () => workspace,
    PROJECTS: workspace.projects, FREE_CHATS: workspace.freeChats,
    sanitizeToolboxes: (boxes) => (Array.isArray(boxes) ? boxes : null),
    defaultToolboxes: () => ['core'],
    PROJECT_ROOT_FOLDER: 'noevia projects',
    createProjectFolder: async (_storage, _connection, root, project) => `${root}/${project.name}`,
    projectSweep: { afterDelete: async (args) => { swept.push(args); } },
  });
  return { store, workspace, indexed, deleted, swept, dir };
}

test('createProject validates, defaults and indexes its files', async () => {
  const f = fixture();
  await assert.rejects(f.store.createProject({}), (e) => e.status === 400 && e.message === 'name required');
  await assert.rejects(f.store.createProject({ name: 'x', reasoningEffort: 'max' }), (e) => e.status === 400 && e.message === 'Invalid reasoning effort');
  await assert.rejects(f.store.createProject({ name: 'x', icon: 'bad' }), (e) => e.status === 400 && e.message === 'unknown icon');
  const project = await f.store.createProject({ name: '  Notes  ', files: [{ name: 'a.md', content: 'hello' }, { name: 3 }], toolboxes: 'nope', routing: 'auto' });
  assert.equal(project.name, 'Notes');
  assert.deepEqual(project.toolboxes, ['core']);
  assert.equal(project.routing, 'auto');
  assert.deepEqual(project.files, [{ name: 'a.md', content: 'hello' }]);
  assert.equal(project.projectFolder, undefined, 'no browsable storage: no folder, and creation still succeeds');
  assert.equal(f.workspace.projects[0], project);
  assert.equal(f.indexed.length, 1);
  assert.equal(f.store.getProject(project.id), project);
  assert.equal(f.store.getProject('missing'), null);
});

test('with browsable storage a new project gets its own folder attached as a source', async () => {
  const f = fixture({ browsable: true });
  const project = await f.store.createProject({ name: 'Trip' });
  assert.equal(project.projectFolder, 'noevia projects/Trip');
  assert.deepEqual(project.sourceFolders, ['noevia projects/Trip']);
});

test('chat metas are sanitized on read and deleting one leaves a tombstone and removes its transcript', async () => {
  const f = fixture();
  const project = await f.store.createProject({ name: 'P' });
  project.chats = [{ id: 'c1', title: 'one' }, 'orphan-id'];
  assert.deepEqual(f.store.loadChats(project.id).map((c) => c.id), ['c1']);
  assert.deepEqual(f.store.loadChats('missing'), []);
  f.store.writeHistory('c1', [{ role: 'user', content: 'hi' }]);
  assert.deepEqual(f.store.readHistory('c1'), [{ role: 'user', content: 'hi' }]);
  assert.equal(f.store.deleteChat(project.id, 'c1'), true);
  assert.equal(f.store.deleteChat(project.id, 'c1'), false);
  assert.equal(f.store.deleteChat('missing', 'c1'), false);
  assert.deepEqual(f.store.readHistory('c1'), [], 'the transcript file is gone');
  assert.ok(require('./chat-lists.cjs').readTombstones(f.dir).has('c1'));
});

test('free chats delete the same way and history keys are sanitized', () => {
  const f = fixture();
  f.workspace.freeChats.push({ id: 'f1' }, { id: 'f2' });
  f.store.writeHistory('f1/../x', []);
  assert.ok(fs.existsSync(path.join(f.dir, 'f1x.json')), 'path characters are stripped from the history key');
  assert.equal(f.store.deleteFreeChat('f1'), true);
  assert.deepEqual(f.workspace.freeChats.map((c) => c.id), ['f2']);
  assert.equal(f.store.deleteFreeChat('f1'), false);
  assert.equal(f.workspace.savedFree, 1);
});

test('ownsFile allows only files directly inside an attached folder', () => {
  const { store } = fixture();
  const project = { projectFolder: 'noevia projects/P', sourceFolders: ['noevia projects/P', 'Shared/Docs'], files: [] };
  assert.equal(store.ownsFile(project, 'noevia projects/P/a.txt'), true);
  assert.equal(store.ownsFile(project, 'Shared/Docs/b.pdf'), true);
  assert.equal(store.ownsFile(project, 'Shared/Docs/nested/c.pdf'), false, 'a sub-path is not reachable through its parent');
  assert.equal(store.ownsFile(project, 'Shared/Other/d.pdf'), false);
  assert.equal(store.ownsFile(project, 'noevia projects/P/..'), false);
  assert.equal(store.ownsFile(null, 'x'), false);
  const attachment = { name: 'noevia projects/P/Documents/e.docx', attachment: {}, source: 'noevia projects/P' };
  assert.equal(store.ownsFile({ ...project, files: [attachment] }, attachment.name), true, 'a managed upload sits one level down');
});

test('withSourceLock serializes operations on one project and prunes when the last one ends', async () => {
  const f = fixture();
  const project = await f.store.createProject({ name: 'P' });
  const order = [];
  const first = f.store.withSourceLock(project, async () => { await new Promise((r) => setTimeout(r, 20)); order.push('first'); return 1; });
  const second = f.store.withSourceLock(project, async () => { order.push('second'); return 2; });
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.deepEqual(order, ['first', 'second']);
  await assert.rejects(f.store.withSourceLock(project, async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await f.store.withSourceLock(project, async () => 'after a failure'), 'after a failure');
});

test('sweepDeletedProject hands the sweeper the tenant root, local dirs and the storage folder', async () => {
  const f = fixture();
  const project = await f.store.createProject({ name: 'P' });
  f.store.sweepDeletedProject({ ...project, projectFolder: 'noevia projects/P' });
  await new Promise((r) => setImmediate(r));
  assert.equal(f.swept.length, 1);
  assert.equal(f.swept[0].projectId, project.id);
  assert.equal(f.swept[0].tenantRoot, f.dir);
  assert.equal(f.swept[0].folder, 'noevia projects/P');
  assert.equal(f.swept[0].localDirs.length, 3);
});

test('new projects default to Auto routing; Manual only when asked for', async () => {
  const f = fixture();
  assert.equal((await f.store.createProject({ name: 'A' })).routing, 'auto');
  assert.equal((await f.store.createProject({ name: 'B', routing: 'manual' })).routing, 'manual');
  f.workspace.preferences = { defaultRouting: 'manual' };
  assert.equal((await f.store.createProject({ name: 'C' })).routing, 'manual', 'the user\'s default applies');
  assert.equal((await f.store.createProject({ name: 'D', routing: 'auto' })).routing, 'auto');
});
