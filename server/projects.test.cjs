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
  // #659: files sent with the create call are uploads, so the Project documents box comes with
  // them (this fixture offers every box). Without files a new project has Core only.
  assert.deepEqual(project.toolboxes, ['core', 'project-docs']);
  assert.equal(project.routing, 'auto');
  assert.deepEqual(project.files, [{ name: 'a.md', content: 'hello' }]);
  assert.equal(project.projectFolder, undefined, 'no browsable storage: no folder, and creation still succeeds');
  assert.equal(f.workspace.projects[0], project);
  assert.equal(f.indexed.length, 1);
  assert.equal(f.store.getProject(project.id), project);
  assert.equal(f.store.getProject('missing'), null);
  assert.deepEqual((await f.store.createProject({ name: 'Empty' })).toolboxes, ['core']);
  assert.deepEqual((await f.store.createProject({ name: 'Chosen', files: [{ name: 'b.md', content: 'x' }], toolboxes: ['core'] })).toolboxes, ['core'], 'an explicit choice stands');
});

test('with browsable storage a new project makes no storage folder until its first upload (#589)', async () => {
  const f = fixture({ browsable: true });
  const project = await f.store.createProject({ name: 'Trip' });
  assert.equal(project.projectFolder, undefined);
  assert.deepEqual(project.sourceFolders, []);
  // The folder is allocated by the first upload path, which shares one allocation per project.
  assert.equal(await f.store.ensureProjectFolder(project), 'noevia projects/Trip');
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

test('a concurrent upload and prune on the same project do not lose the in-flight file', async () => {
  // Regression for the theoretical race in uploads.cjs prune(): an ingest that
  // writes its temp file and renames it to <hash> before project.files is
  // updated, racing a prune() from another request that has not yet seen the
  // new file in project.files and so would delete it. withSourceLock() must
  // serialize the two so prune only ever runs once ingest has landed (or not
  // at all yet), never in between.
  const uploads = require('./uploads.cjs');
  const f = fixture();
  const project = await f.store.createProject({ name: 'P' });
  const workspace = f.workspace;
  const bytes = Buffer.from('synthetic upload contents, not a real Diary prompt');

  const uploadOp = f.store.withSourceLock(project, async () => {
    // Simulate the route: ingest writes the original to disk, then the route
    // commits it into project.files, all inside the lock.
    await new Promise((r) => setTimeout(r, 10));
    const file = await uploads.ingest(workspace, project, 'note.txt', bytes, {});
    project.files = [...(project.files || []), file];
    return file;
  });
  // A second request's delete-triggered prune, queued behind the upload via the same lock.
  const pruneOp = f.store.withSourceLock(project, async () => {
    uploads.prune(workspace, project);
  });

  const file = await uploadOp;
  await pruneOp;

  const dir = uploads.directory(workspace, project.id);
  assert.ok(fs.existsSync(path.join(dir, file.attachment.id)), 'the freshly ingested original survives a queued concurrent prune');
  assert.equal(project.files.some((x) => x.name === 'note.txt'), true);
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

test('getProject self-heals a pre-#352 standalone chat context stuck on manual, but never a real choice', () => {
  const f = fixture();
  // Simulates a project persisted before #352 was fixed: diaryExtras.newProject() forced
  // routing:'manual' on every standalone chat's shadow context object, and nobody ever chose it
  // (no routingChosen — that flag is new, set only by the routing PATCH).
  const stale = { id: 'cowork-chat-context-abc', name: 'Chat attachments abc', routing: 'manual', toolboxes: ['core'] };
  f.workspace.projects.push(stale);
  assert.equal(f.store.getProject('cowork-chat-context-abc').routing, 'auto', 'inherited default is healed to Auto');
  assert.equal(f.workspace.saved > 0, true, 'the heal is persisted so it does not have to rerun forever');

  // A real explicit choice (routingChosen set, however it got there) must never be reverted.
  const chosen = { id: 'cowork-chat-context-xyz', name: 'Chat attachments xyz', routing: 'manual', routingChosen: true, toolboxes: ['core'] };
  f.workspace.projects.push(chosen);
  assert.equal(f.store.getProject('cowork-chat-context-xyz').routing, 'manual', 'an explicit Manual choice stays Manual');

  // The Diary project's own manual default (unrelated id shape) is never touched by this heal.
  const diary = { id: 'cowork-diary-extras', name: 'Diary attachments', routing: 'manual', toolboxes: ['core'] };
  f.workspace.projects.push(diary);
  assert.equal(f.store.getProject('cowork-diary-extras').routing, 'manual');

  // Once healed, a second read must not need to heal again (idempotent, and routingChosen is not
  // required to stay Auto — only Manual needs the explicit-choice guard).
  const savedBefore = f.workspace.saved;
  f.store.getProject('cowork-chat-context-abc');
  assert.equal(f.workspace.saved, savedBefore, 'already-Auto reads do not trigger a re-save');
});

test('withSourceLock is keyed by project id, so a rebuilt project object still waits for the lock (#217)', async () => {
  const f = fixture();
  const project = await f.store.createProject({ name: 'P' });
  const rebuilt = { ...project }; // what a reload of the project list hands the next request
  f.workspace.projects.splice(0, 1, rebuilt);
  const order = [];
  const first = f.store.withSourceLock(project, async () => { await new Promise((r) => setTimeout(r, 20)); order.push('old-object'); });
  const second = f.store.withSourceLock(rebuilt, async () => { order.push('new-object'); });
  await Promise.all([first, second]);
  assert.deepEqual(order, ['old-object', 'new-object'], 'the second operation queued behind the first');
});

test('withSourceLock is re-entrant for the same project and never deadlocks (#217)', async () => {
  const f = fixture();
  const project = await f.store.createProject({ name: 'P' });
  const result = await Promise.race([
    f.store.withSourceLock(project, () => f.store.withSourceLock({ ...project }, async () => 'inner ran')),
    new Promise((resolve) => setTimeout(() => resolve('deadlocked'), 500)),
  ]);
  assert.equal(result, 'inner ran');
  // A sibling (not nested) operation still waits for the outer one.
  const order = [];
  const outer = f.store.withSourceLock(project, async () => { await f.store.withSourceLock(project, async () => order.push('nested')); await new Promise((r) => setTimeout(r, 10)); order.push('outer-done'); });
  const sibling = f.store.withSourceLock(project, async () => order.push('sibling'));
  await Promise.all([outer, sibling]);
  assert.deepEqual(order, ['nested', 'outer-done', 'sibling']);
  await assert.rejects(f.store.withSourceLock({}, async () => 1), /needs a project with an id/);
});

test('withSourceLock keys differ per tenant: the same project id in another workspace does not wait (#217)', async () => {
  const f = fixture();
  const project = await f.store.createProject({ name: 'P' });
  const order = [];
  let release;
  const held = f.store.withSourceLock(project, () => new Promise((r) => { release = r; }));
  const originalUser = f.workspace.userId;
  f.workspace.userId = 'u2';
  const other = f.store.withSourceLock({ id: project.id }, async () => order.push('other tenant'));
  f.workspace.userId = originalUser;
  await other;
  assert.deepEqual(order, ['other tenant']);
  release(); await held;
});

test('deleting a chat or a project removes its context meter, tenant-scoped (#554)', async () => {
  const context = require('./chat-context.cjs');
  const lists = require('./chat-lists.cjs');
  const f = fixture();
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-projects-other-'));
  try {
    const meter = { meter: { model: 'synthetic', used: 10 } };
    const project = await f.store.createProject({ name: 'Doomed' });
    const keep = await f.store.createProject({ name: 'Kept' });
    project.chats = [{ id: 'c-a' }, { id: 'c-b' }];
    keep.chats = [{ id: 'c-keep' }];
    for (const id of ['c-a', 'c-b', 'c-keep', 'c-free']) { context.save(f.dir, id, meter); fs.writeFileSync(f.workspace.historyPath(id), '[]'); }
    f.workspace.freeChats.push({ id: 'c-free' });
    context.save(other, 'c-a', meter); // another user's chat that happens to share an id
    assert.equal(f.store.deleteChat(keep.id, 'c-keep'), true);
    assert.deepEqual(context.read(f.dir, 'c-keep'), {});
    assert.equal(f.store.deleteFreeChat('c-free'), true);
    assert.deepEqual(context.read(f.dir, 'c-free'), {});
    f.store.purgeProjectChats(project);
    for (const id of ['c-a', 'c-b']) {
      assert.deepEqual(context.read(f.dir, id), {}, id);
      assert.equal(fs.existsSync(f.workspace.historyPath(id)), false, id);
      assert.ok(lists.readTombstones(f.dir).has(id), id);
    }
    assert.deepEqual(context.read(other, 'c-a'), meter, "another user's meter is untouched");
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  }
});

test('every delete path removes the chat brain, best effort (#756)', async () => {
  const brain = require('./chat-brain.cjs');
  const f = fixture();
  const file = (id) => path.join(f.dir, brain.BRAIN_DIR, `${require('node:crypto').createHash('sha256').update(id).digest('hex')}.json`);
  const write = (id) => { fs.mkdirSync(path.dirname(file(id)), { recursive: true }); fs.writeFileSync(file(id), '{}'); };
  const project = await f.store.createProject({ name: 'Brains' });
  project.chats = [{ id: 'b-proj' }, { id: 'b-purge' }];
  f.workspace.freeChats.push({ id: 'b-free' });
  for (const id of ['b-proj', 'b-purge', 'b-free']) write(id);
  assert.equal(f.store.deleteChat(project.id, 'b-proj'), true);
  assert.equal(fs.existsSync(file('b-proj')), false);
  assert.equal(f.store.deleteFreeChat('b-free'), true);
  assert.equal(fs.existsSync(file('b-free')), false);
  f.store.purgeProjectChats(project);
  assert.equal(fs.existsSync(file('b-purge')), false);
  project.chats = [{ id: 'b-none' }];
  assert.equal(f.store.deleteChat(project.id, 'b-none'), true, 'no brain file is fine');
});

test('saveChats skips ids held by another list of the workspace (#755)', async () => {
  const f = fixture();
  const a = await f.store.createProject({ name: 'A' }), b = await f.store.createProject({ name: 'B' });
  b.chats = [{ id: 'in-b', updatedAt: 1 }];
  f.workspace.freeChats.push({ id: 'free-1', updatedAt: 1 });
  const skipped = f.store.saveChats(a.id, [{ id: 'in-b' }, { id: 'free-1' }, { id: 'new-a' }]);
  assert.deepEqual(a.chats.map((c) => c.id), ['new-a']);
  assert.deepEqual(skipped.sort(), ['free-1', 'in-b'], 'the dropped ids are reported (#765)');
  assert.deepEqual(f.store.saveChats(a.id, [{ id: 'new-a' }]), [], 'nothing skipped, nothing reported');
  assert.deepEqual([...f.store.chatIdsElsewhere(null)].sort(), ['in-b', 'new-a']);
});

test('moveChat takes a meta out of one list and into another without a tombstone (#738)', async () => {
  const f = fixture();
  const a = await f.store.createProject({ name: 'A' }), b = await f.store.createProject({ name: 'B' });
  f.workspace.freeChats.push({ id: 'f1', title: 'Free one', updatedAt: 1 }, { id: 'f2', title: 'Other', updatedAt: 2 });
  const frame = { projectId: a.id, kind: 'search', tags: ['#trip plans'], links: ['f2'], confirmed: true, source: 'user' };
  assert.deepEqual(f.store.moveChat('f1', a.id, { frame }), { status: 200, from: null });
  assert.deepEqual(f.workspace.freeChats.map((c) => c.id), ['f2'], 'only the moved chat left the free list');
  assert.equal(a.chats[0].id, 'f1');
  assert.equal(a.chats[0].title, 'Free one');
  assert.deepEqual(a.chats[0].frame, { ...frame, tags: ['trip-plans'] }, 'the frame is normalized as a list save would');
  assert.deepEqual(f.store.moveChat('f1', b.id), { status: 200, from: a.id }, 'project to project');
  assert.deepEqual(a.chats, []);
  assert.equal(b.chats[0].frame.kind, 'search', 'a move without a frame keeps the stored one');
  assert.deepEqual(f.store.moveChat('f1', b.id, { frame: { ...frame, kind: 'idea' } }), { status: 200, from: b.id }, 'in place');
  assert.equal(b.chats.length, 1);
  assert.equal(b.chats[0].frame.kind, 'idea');
  assert.ok(!require('./chat-lists.cjs').readTombstones(f.dir).has('f1'), 'never tombstoned');
});

test('moveChat refuses unknown chats and projects, deleted chats and disallowed projects, changing nothing (#738)', async () => {
  const f = fixture();
  const a = await f.store.createProject({ name: 'A' });
  const internal = await f.store.createProject({ name: 'Internal' });
  internal.chats = [{ id: 'i1', title: 'inside' }];
  f.workspace.freeChats.push({ id: 'f1', title: 'Free', updatedAt: 1 });
  const before = f.workspace.saved;
  assert.equal(f.store.moveChat('f1', 'missing').status, 404);
  assert.equal(f.store.moveChat('nope', a.id).status, 404);
  assert.equal(f.store.moveChat('', null).status, 404);
  const allowed = (p) => p.id !== internal.id;
  assert.equal(f.store.moveChat('f1', internal.id, {}, allowed).status, 404, 'not into a project the caller may not use');
  assert.equal(f.store.moveChat('i1', a.id, {}, allowed).status, 404, 'not out of one either');
  assert.deepEqual(f.workspace.freeChats.map((c) => c.id), ['f1']);
  assert.deepEqual(internal.chats.map((c) => c.id), ['i1']);
  assert.equal(f.workspace.saved, before, 'nothing was saved');
  assert.equal(f.store.deleteFreeChat('f1'), true);
  f.workspace.freeChats.push({ id: 'f1', title: 'stale copy' });
  assert.equal(f.store.moveChat('f1', a.id).status, 404, 'a tombstoned chat is never moved back to life');
});

test('moveChat never moves a chat into a project it cannot live in, but in place and out still work (#810)', async () => {
  const f = fixture();
  const { chatDestination } = require('./project-modes.cjs');
  const chat = await f.store.createProject({ name: 'Chat' });
  const code = await f.store.createProject({ name: 'Code only', modes: ['code'] });
  const old = await f.store.createProject({ name: 'Archived' });
  old.archived = true;
  old.chats = [{ id: 'in-old', title: 'Kept', updatedAt: 1 }];
  f.workspace.freeChats.push({ id: 'f1', title: 'Free', updatedAt: 1 });
  const frame = { kind: 'idea', tags: [], links: [], confirmed: true, source: 'user' };
  const before = f.workspace.saved;
  assert.equal(f.store.moveChat('f1', code.id, { frame }, () => true, chatDestination).status, 404, 'not into a Code-only project');
  assert.equal(f.store.moveChat('f1', old.id, { frame }, () => true, chatDestination).status, 404, 'not into an archived project');
  assert.deepEqual(f.workspace.freeChats.map((c) => c.id), ['f1']);
  assert.equal(f.workspace.saved, before, 'nothing was saved');
  assert.equal(f.store.moveChat('in-old', old.id, { frame }, () => true, chatDestination).status, 200, 'a frame is still saved in place');
  assert.equal(old.chats[0].frame.kind, 'idea');
  assert.deepEqual(f.store.moveChat('in-old', chat.id, {}, () => true, chatDestination), { status: 200, from: old.id }, 'and the chat can be moved out');
  assert.deepEqual(f.store.moveChat('f1', chat.id, {}, () => true, chatDestination), { status: 200, from: null });
});
