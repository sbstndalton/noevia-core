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

function fixture({ browsable = false, folderError = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-projects-'));
  const workspace = {
    dir, userId: 'u1', projects: [], freeChats: [],
    saved: 0, savedFree: 0,
    saveProjects() { this.saved += 1; }, saveFreeChats() { this.savedFree += 1; },
    historyPath: (id) => path.join(dir, `${id}.json`),
    assetDir: (id) => path.join(dir, 'assets', id),
  };
  // #1071 slice 6: a double of the Rust store's chat delete (project-store-client chatDelete) over
  // this fake workspace's in-memory lists: it records each call, tombstones and takes the meta out
  // as the store does on disk. It removes no file: the transcript, meter, brain note and partial
  // are the real store's (noevia-rs chat_delete tests), so a file still there after a delete here
  // proves Node removed nothing itself.
  const storeCalls = [];
  workspace.transcripts = {
    deleteChat: async (chatId, options = {}) => {
      storeCalls.push({ chatId, ...options });
      const none = { deleted: false, swept: false, leftovers: 0 };
      const held = (list) => Array.isArray(list) && list.some((c) => c && c.id === chatId);
      if (options.kind === 'unlisted') {
        if (held(workspace.freeChats) || workspace.projects.some((p) => held(p.chats))) return { ...none, listed: true };
        require('./chat-lists.cjs').addTombstone(dir, chatId);
        return { ...none, deleted: true };
      }
      const owner = options.kind === 'free' ? null : workspace.projects.find((p) => p.id === options.projectId);
      const list = options.kind === 'free' ? workspace.freeChats : owner?.chats;
      if (!held(list)) return none;
      require('./chat-lists.cjs').addTombstone(dir, chatId);
      if (owner) owner.chats = owner.chats.filter((c) => !(c && c.id === chatId));
      else workspace.freeChats.splice(0, workspace.freeChats.length, ...workspace.freeChats.filter((c) => !(c && c.id === chatId)));
      return { ...none, deleted: true };
    },
  };
  const indexed = [], deleted = [], swept = [];
  const store = createProjectStore({
    fs, path,
    reasoningEffort: { validEffort: (e) => ['default', 'low', 'high'].includes(e) },
    projectAppearance: (body) => (body.icon === 'bad' ? (() => { throw new Error('unknown icon'); })() : { icon: body.icon || 'folder' }),
    rag: { indexProjectFile: async (...args) => { indexed.push(args); return { ok: true, stored: 1, embedded: 1 }; }, deleteProjectFile: (...args) => deleted.push(args) },
    storageClient: { isBrowsable: () => browsable, refusedLogin: require('./storage-client.cjs').refusedLogin, storageFailure: require('./storage-client.cjs').storageFailure },
    documentSources: { prune() {}, directory: () => path.join(dir, 'docs') },
    authService: { getStorage: () => ({ kind: browsable ? 'webdav' : 'local' }) },
    currentWorkspace: () => workspace,
    PROJECTS: workspace.projects, FREE_CHATS: workspace.freeChats,
    sanitizeToolboxes: (boxes) => (Array.isArray(boxes) ? boxes : null),
    defaultToolboxes: () => ['core'],
    PROJECT_ROOT_FOLDER: 'noevia projects',
    createProjectFolder: async (_storage, _connection, root, project) => { if (folderError) throw folderError; return `${root}/${project.name}`; },
    projectSweep: { afterDelete: async (args) => { swept.push(args); } },
  });
  return { store, workspace, indexed, deleted, swept, dir, storeCalls };
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

test('#849: ensureProjectFolderDetailed says when storage refused the login, and ensureProjectFolder still just returns null', async () => {
  const rejected = fixture({ browsable: true, folderError: Object.assign(new Error('could not create "noevia projects" (401)'), { status: 502, upstream: 401 }) });
  const project = await rejected.store.createProject({ name: 'Trip' });
  assert.deepEqual(await rejected.store.ensureProjectFolderDetailed(project), { folder: null, loginRejected: true, failure: { kind: 'login' } });
  assert.equal(await rejected.store.ensureProjectFolder(project), null);
  const down = fixture({ browsable: true, folderError: Object.assign(new Error('could not create "noevia projects" (500)'), { status: 502, upstream: 500 }) });
  assert.deepEqual(await down.store.ensureProjectFolderDetailed(await down.store.createProject({ name: 'Trip' })), { folder: null, loginRejected: false, failure: null });
  const none = fixture({ browsable: false });
  assert.deepEqual(await none.store.ensureProjectFolderDetailed(await none.store.createProject({ name: 'Trip' })), { folder: null, loginRejected: false, failure: null });
  const ok = fixture({ browsable: true });
  assert.deepEqual(await ok.store.ensureProjectFolderDetailed(await ok.store.createProject({ name: 'Trip' })), { folder: 'noevia projects/Trip', loginRejected: false, failure: null });
});

test('chat metas are sanitized on read; deleting one is the store\'s operation, Node removes no file (#1071 slice 6)', async () => {
  const f = fixture();
  const project = await f.store.createProject({ name: 'P' });
  project.chats = [{ id: 'c1', title: 'one' }, 'orphan-id'];
  assert.deepEqual(f.store.loadChats(project.id).map((c) => c.id), ['c1']);
  assert.deepEqual(f.store.loadChats('missing'), []);
  // The transcript as the Rust store wrote it (#1071 slice 4: Node never writes it).
  fs.writeFileSync(f.workspace.historyPath('c1'), JSON.stringify({ history: [{ role: 'user', content: 'hi' }] }));
  assert.deepEqual(f.store.readHistory('c1'), [{ role: 'user', content: 'hi' }]);
  assert.equal(await f.store.deleteChat(project.id, 'c1'), true);
  assert.equal(await f.store.deleteChat(project.id, 'c1'), false);
  assert.equal(await f.store.deleteChat('missing', 'c1'), false);
  assert.deepEqual(f.storeCalls.map((c) => [c.chatId, c.kind, c.projectId, c.origin]), [
    ['c1', 'project', project.id, 'remove'], ['c1', 'project', project.id, 'remove'], ['c1', 'project', 'missing', 'remove']]);
  assert.ok(fs.existsSync(f.workspace.historyPath('c1')), 'Node itself removes no transcript (the store does, under its lock)');
  assert.ok(require('./chat-lists.cjs').readTombstones(f.dir).has('c1'));
});

test('free chats delete through the store the same way and history keys are sanitized', async () => {
  const f = fixture();
  f.workspace.freeChats.push({ id: 'f1' }, { id: 'f2' });
  fs.writeFileSync(path.join(f.dir, 'f1x.json'), JSON.stringify({ history: ['qa'] }));
  assert.deepEqual(f.store.readHistory('f1/../x'), ['qa'], 'path characters are stripped from the history key');
  assert.equal(f.store.writeHistory, undefined, '#1071 slice 4: no local transcript writer');
  assert.equal(await f.store.deleteFreeChat('f1'), true);
  assert.deepEqual(f.workspace.freeChats.map((c) => c.id), ['f2']);
  assert.equal(await f.store.deleteFreeChat('f1'), false);
  assert.equal(f.workspace.savedFree, 0, 'the store writes the list, not Node');
  assert.deepEqual(f.storeCalls.map((c) => [c.chatId, c.kind]), [['f1', 'free'], ['f1', 'free']]);
});

test('a store failure rejects the delete and Node changes nothing (#1914, #1071 slice 6)', async () => {
  const f = fixture();
  f.workspace.freeChats.push({ id: 'f1' });
  f.workspace.transcripts.deleteChat = async () => { throw Object.assign(new Error('The project store is busy. Try again shortly.'), { status: 503, code: 'PROJECTS_BUSY' }); };
  await assert.rejects(f.store.deleteFreeChat('f1'), (e) => e.status === 503);
  assert.deepEqual(f.workspace.freeChats.map((c) => c.id), ['f1']);
  assert.equal(require('./chat-lists.cjs').readTombstones(f.dir).has('f1'), false);
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
  // #784: only the canonical form the storage client sends is accepted. A backslash is a
  // separator to the storage client, so these would otherwise reach a sub-path.
  assert.equal(store.ownsFile(project, 'Shared/Docs/nested\\c.pdf'), false, 'a backslash cannot smuggle a sub-path');
  assert.equal(store.ownsFile(project, 'Shared/Docs\\b.pdf'), false);
  assert.equal(store.ownsFile(project, 'Shared//Docs/b.pdf'), false, 'an empty segment is not collapsed into a match');
  assert.equal(store.ownsFile(project, 'Shared/Docs/b.pdf '), false, 'a target the storage client would trim names another file');
  assert.equal(store.ownsFile(project, ' Shared/Docs/b.pdf'), false);
  assert.equal(store.ownsFile(project, 'Shared/Docs/./b.pdf'), false);
  assert.equal(store.ownsFile({ ...project, files: [attachment] }, 'noevia projects/P/Documents\\e.docx'), false, 'the managed-upload branch is canonical too');
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

test('every delete path goes through the store\'s delete; Node removes no meter, brain or transcript itself (#554, #756, #1071 slice 6)', async () => {
  const context = require('./chat-context.cjs');
  const brain = require('./chat-brain.cjs');
  const lists = require('./chat-lists.cjs');
  const f = fixture();
  try {
    const meter = { meter: { model: 'synthetic', used: 10 } };
    const project = await f.store.createProject({ name: 'Doomed' });
    const keep = await f.store.createProject({ name: 'Kept' });
    project.chats = [{ id: 'c-a' }, { id: 'c-b' }, 'not-a-meta'];
    keep.chats = [{ id: 'c-keep' }];
    f.workspace.freeChats.push({ id: 'c-free' });
    for (const id of ['c-a', 'c-b', 'c-keep', 'c-free']) {
      context.save(f.dir, id, meter);
      fs.writeFileSync(f.workspace.historyPath(id), '[]');
      brain.writeBrain(f.dir, id, { brain: { brain_schema: 1, summary: 'qa', decisions: [], facts: [], open_questions: [], entities: [] } });
    }
    assert.equal(await f.store.deleteChat(keep.id, 'c-keep'), true);
    assert.equal(await f.store.deleteFreeChat('c-free'), true);
    // A deleted project's chats: in no list any more, so asked as unlisted, one at a time.
    f.workspace.projects.splice(f.workspace.projects.indexOf(project), 1);
    await f.store.purgeProjectChats(project);
    assert.deepEqual(f.storeCalls.map((c) => [c.chatId, c.kind]), [['c-keep', 'project'], ['c-free', 'free'], ['c-a', 'unlisted'], ['c-b', 'unlisted']]);
    for (const id of ['c-a', 'c-b', 'c-keep', 'c-free']) {
      assert.deepEqual(context.read(f.dir, id), meter, `${id}: the meter is the store's to remove`);
      assert.ok(fs.existsSync(f.workspace.historyPath(id)), id);
      assert.ok(brain.readBrain(f.dir, id), id);
      assert.ok(lists.readTombstones(f.dir).has(id), id);
    }
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('a deleted project\'s chat that another list holds by now is left alone (#1071 slice 6)', async () => {
  const f = fixture();
  const project = await f.store.createProject({ name: 'Gone' });
  project.chats = [{ id: 'moved' }];
  f.workspace.projects.splice(f.workspace.projects.indexOf(project), 1);
  f.workspace.freeChats.push({ id: 'moved' });
  await f.store.purgeProjectChats(project);
  assert.equal(require('./chat-lists.cjs').readTombstones(f.dir).has('moved'), false);
  assert.deepEqual(f.workspace.freeChats.map((c) => c.id), ['moved']);
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

// Public moves and wrapper retired; Rust owns metadata/transaction tests.
test('Node project store exports no duplicate move writer or delegate',()=>{
 const f=fixture();assert.equal(f.store.moveChat,undefined);
});
test('#1522: a new project starts on Automatic tools unless the request chose Manual', async () => {
  const f = fixture();
  const auto = await f.store.createProject({ name: 'Plan' });
  assert.equal(auto.toolsMode, 'auto', 'the web sends no toolboxes or toolsMode: Automatic, not a Manual list');
  assert.equal(require('./tools-mode.cjs').toolsModeOf(auto), 'auto');
  const hand = await f.store.createProject({ name: 'Hand', toolboxes: ['core'] });
  assert.equal(hand.toolsMode, 'manual', 'an explicit toolbox list is a hand pick');
  assert.deepEqual(hand.toolboxes, ['core']);
  assert.equal((await f.store.createProject({ name: 'Chosen', toolsMode: 'manual' })).toolsMode, 'manual');
  assert.equal((await f.store.createProject({ name: 'Auto', toolsMode: 'auto', toolboxes: ['core'] })).toolsMode, 'auto');
});

// sbstndalton/noevia#2230: the store can delete a chat and fail to remove its transcript (leftovers).
// A retention sweep, which is about to say "gone", must see that as a failure; a person's own delete
// (the chat is gone from every list and tombstoned, so the Rust front reads it as no transcript; the file stays
// on disk until a delete of that id is asked again, nothing sweeps it later: #2245) stays a success.
test('a delete with leftovers is a failure only when the caller needs the chat gone (#2230)', async () => {
  const f = fixture();
  const project = await f.store.createProject({ name: 'P' });
  project.chats = [{ id: 'c1', title: 'one' }, { id: 'c2', title: 'two' }];
  const real = f.workspace.transcripts.deleteChat;
  f.workspace.transcripts.deleteChat = async (...a) => ({ ...(await real(...a)), leftovers: 1 });
  assert.equal(await f.store.deleteChat(project.id, 'c1'), true);
  await assert.rejects(f.store.deleteChat(project.id, 'c2', { requireGone: true }), (e) => e.status === 503);
});
