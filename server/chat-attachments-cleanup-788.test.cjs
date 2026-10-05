'use strict';
// #788: a free chat's hidden attachments project (`cowork-chat-context-<chatId>`) goes with the
// chat, through the same cleanup a project delete runs, and only that one, only in the caller's
// own workspace. The store runs against two synthetic workspaces behind request-scoped array
// views, exactly as index.cjs builds them (arrayProxy), with the real upload/document pruning
// and the real D8 sweep; storage is a fake that records what it was asked to remove.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createProjectStore } = require('./projects.cjs');
const { createProjectSweep } = require('./project-sweep.cjs');
const uploads = require('./uploads.cjs');
const documentSources = require('./document-sources.cjs');
const lists = require('./chat-lists.cjs');

const CONTEXT = (chatId) => `cowork-chat-context-${chatId}`;
const tick = () => new Promise((r) => setImmediate(r));

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-788-'));
  const make = (userId) => {
    const dir = path.join(root, userId);
    fs.mkdirSync(dir, { recursive: true });
    return {
      dir, userId, projects: [], freeChats: [], saved: 0,
      saveProjects() { this.saved += 1; }, saveFreeChats() {},
      historyPath: (id) => path.join(dir, `history-${String(id).replace(/[^a-zA-Z0-9_-]/g, '')}.json`),
      ragDir: () => path.join(dir, 'rag'),
      assetDir: (id) => path.join(dir, 'project-assets', String(id).replace(/[^a-zA-Z0-9_-]/g, '')),
    };
  };
  const alice = make('alice'), bob = make('bob');
  let active = alice;
  const view = (field) => new Proxy([], {
    get(_t, prop) { const v = active[field][prop]; return typeof v === 'function' ? v.bind(active[field]) : v; },
    set(_t, prop, value) { active[field][prop] = value; return true; },
    ownKeys() { return Reflect.ownKeys(active[field]); },
    getOwnPropertyDescriptor() { return { enumerable: true, configurable: true }; },
  });
  const remoteRemovals = [];
  const storage = { removeEmptyFolder: async (_conn, target) => { remoteRemovals.push(target); return { removed: true }; } };
  const store = createProjectStore({
    fs, path,
    reasoningEffort: { validEffort: () => true },
    projectAppearance: () => ({}),
    rag: { indexProjectFile: async () => ({ ok: true, stored: 1, embedded: 1 }), deleteProjectFile() {} },
    storageClient: { isBrowsable: () => false },
    documentSources,
    authService: { getStorage: () => ({ kind: 'webdav', url: 'https://storage.invalid' }) },
    currentWorkspace: () => active,
    PROJECTS: view('projects'), FREE_CHATS: view('freeChats'),
    sanitizeToolboxes: (b) => (Array.isArray(b) ? b : null), defaultToolboxes: () => ['core'],
    PROJECT_ROOT_FOLDER: 'noevia projects',
    createProjectFolder: async () => null,
    projectSweep: createProjectSweep({ storage }),
  });
  const as = (workspace, fn) => { const prev = active; active = workspace; try { return fn(); } finally { active = prev; } };
  return { store, alice, bob, as, remoteRemovals, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

// A project with everything a delete has to clean: an upload original, a document original and its
// pages, an image asset, RAG index files, a noevia-allocated storage folder and a folder the user
// attached by hand. Synthetic bytes only.
function seedProject(workspace, id, { projectFolder = `noevia projects/${id}`, chats = [] } = {}) {
  const project = { id, name: id, files: [], chats, sourceFolders: [projectFolder, 'Shared/Manual'], projectFolder,
    assets: [{ id: 'img-synthetic', name: 'synthetic.png', mime: 'image/png', bytes: 3 }] };
  workspace.projects.push(project);
  const paths = {
    upload: path.join(uploads.directory(workspace, id), 'a'.repeat(64)),
    document: path.join(documentSources.directory(workspace, id), 'b'.repeat(64) + '.pdf'),
    pages: path.join(documentSources.directory(workspace, id), 'c'.repeat(64) + '.json'),
    asset: path.join(workspace.assetDir(id), 'img-synthetic'),
    rag: path.join(workspace.ragDir(), `${id}.db`),
    ragWal: path.join(workspace.ragDir(), `${id}.db-wal`),
  };
  for (const file of Object.values(paths)) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'synthetic'); }
  paths.dirs = [uploads.directory(workspace, id), documentSources.directory(workspace, id), workspace.assetDir(id)];
  return { project, paths };
}
const allExist = (paths) => [...Object.entries(paths)].filter(([k]) => k !== 'dirs').every(([, p]) => fs.existsSync(p)) && paths.dirs.every((d) => fs.existsSync(d));
const noneExist = (paths) => [...Object.entries(paths)].filter(([k]) => k !== 'dirs').every(([, p]) => !fs.existsSync(p)) && paths.dirs.every((d) => !fs.existsSync(d));

test('deleting a free chat removes its attachments project: record, local files, RAG index (#788)', async () => {
  const f = fixture();
  try {
    f.alice.freeChats.push({ id: 'c1', title: 'synthetic' }, { id: 'c2', title: 'neighbour' });
    const { paths } = seedProject(f.alice, CONTEXT('c1'));
    const neighbour = seedProject(f.alice, CONTEXT('c2'));
    const regular = seedProject(f.alice, 'proj-regular', { chats: [{ id: 'p-chat' }] });

    assert.equal(f.store.deleteFreeChat('c1'), true);
    await tick();

    assert.deepEqual(f.alice.projects.map((p) => p.id), [CONTEXT('c2'), 'proj-regular'], 'only the deleted chat\'s project is gone');
    assert.ok(noneExist(paths), 'its upload originals, documents, assets and RAG files and their emptied directories are gone');
    assert.ok(allExist(neighbour.paths), "another chat's attachments are untouched");
    assert.ok(allExist(regular.paths), 'a regular project is untouched');
    assert.deepEqual(f.alice.projects[1].chats, [{ id: 'p-chat' }], "a regular project's chats are untouched");
    // Storage: only the empty-only sweep of the folder noevia allocated for this chat (as a project
    // delete does); never a file, never the folder the user attached.
    assert.ok(f.remoteRemovals.length > 0);
    for (const target of f.remoteRemovals) assert.ok(target.startsWith(`noevia projects/${CONTEXT('c1')}`), target);
    assert.ok(!f.remoteRemovals.some((t) => t.startsWith('Shared/')), 'a manually attached folder is never touched');
    assert.ok(lists.readTombstones(f.alice.dir).has('c1'));
    assert.equal(f.store.deleteFreeChat('c1'), false, 'a second delete is a 404, nothing more is removed');
  } finally { f.cleanup(); }
});

test("another user's attachments project for the same chat id is untouched (#788)", async () => {
  const f = fixture();
  try {
    f.alice.freeChats.push({ id: 'shared-id' });
    f.bob.freeChats.push({ id: 'shared-id' });
    const mine = seedProject(f.alice, CONTEXT('shared-id'));
    const theirs = seedProject(f.bob, CONTEXT('shared-id'));
    assert.equal(f.as(f.alice, () => f.store.deleteFreeChat('shared-id')), true);
    await tick();
    assert.ok(noneExist(mine.paths));
    assert.deepEqual(f.bob.projects.map((p) => p.id), [CONTEXT('shared-id')], "bob's record stays");
    assert.ok(allExist(theirs.paths), "bob's files stay");
    assert.deepEqual(f.bob.freeChats.map((c) => c.id), ['shared-id']);
    assert.equal(lists.readTombstones(f.bob.dir).has('shared-id'), false);
  } finally { f.cleanup(); }
});

test('a chat that never had an attachments project deletes as before, touching no project (#788)', () => {
  const f = fixture();
  try {
    f.alice.freeChats.push({ id: 'bare' });
    seedProject(f.alice, 'proj-regular');
    const savedBefore = f.alice.saved;
    assert.equal(f.store.deleteFreeChat('bare'), true);
    assert.deepEqual(f.alice.projects.map((p) => p.id), ['proj-regular']);
    assert.equal(f.alice.saved, savedBefore, 'projects.json is not rewritten');
    assert.equal(f.store.removeChatAttachments('bare'), false);
    assert.equal(f.store.removeChatAttachments('../x'), false, 'an id that is not a chat id names no project');
  } finally { f.cleanup(); }
});

test('an archived chat keeps its attachments project; only deleting it removes them (#788)', async () => {
  const f = fixture();
  try {
    f.alice.freeChats.push({ id: 'old', archived: true });
    const { paths } = seedProject(f.alice, CONTEXT('old'));
    assert.equal(f.store.removeOrphanChatContexts(), 0, 'archived is not deleted');
    assert.ok(allExist(paths));
    assert.equal(f.store.deleteFreeChat('old'), true);
    await tick();
    assert.ok(noneExist(paths));
  } finally { f.cleanup(); }
});

test('a chat moved into a project, or deleted with its project, takes its attachments project along (#788)', async () => {
  const f = fixture();
  try {
    const host = seedProject(f.alice, 'proj-host', { chats: [{ id: 'moved' }, { id: 'inner' }] });
    const other = seedProject(f.alice, 'proj-other', { chats: [{ id: 'kept' }] });
    const moved = seedProject(f.alice, CONTEXT('moved'));
    const inner = seedProject(f.alice, CONTEXT('inner'));
    const kept = seedProject(f.alice, CONTEXT('kept'));
    assert.equal(f.store.deleteChat('proj-host', 'moved'), true);
    await tick();
    assert.ok(noneExist(moved.paths));
    assert.equal(f.store.deleteProject('proj-host'), true);
    await tick();
    assert.ok(noneExist(host.paths), 'the project itself is cleaned as before');
    assert.ok(noneExist(inner.paths), "its chats' attachments projects go with their chats");
    assert.deepEqual(f.alice.projects.map((p) => p.id).sort(), [CONTEXT('kept'), 'proj-other']);
    assert.ok(allExist(other.paths) && allExist(kept.paths));
    assert.equal(f.store.deleteProject('proj-host'), false, 'a second delete reports nothing removed');
  } finally { f.cleanup(); }
});

test("removing an attachments project never purges chats filed under it (#788)", async () => {
  const f = fixture();
  try {
    f.alice.freeChats.push({ id: 'host' });
    seedProject(f.alice, CONTEXT('host'), { chats: [{ id: 'stray' }] });
    fs.writeFileSync(f.alice.historyPath('stray'), '{"history":[]}');
    assert.equal(f.store.deleteFreeChat('host'), true);
    assert.equal(fs.existsSync(f.alice.historyPath('stray')), true, "another chat's transcript is not this delete's to remove");
    assert.equal(lists.readTombstones(f.alice.dir).has('stray'), false);
  } finally { f.cleanup(); }
});

test('orphaned attachments projects are removed only when their chat is provably deleted (#788)', async () => {
  const f = fixture();
  try {
    // Left behind by deletes before #788: the chat is tombstoned, its project still there.
    const orphans = ['gone-1', 'gone-2', 'gone-3'].map((id) => { lists.addTombstone(f.alice.dir, id); return seedProject(f.alice, CONTEXT(id)); });
    // Opened in a tab, no message yet: in no list, not tombstoned. Must stay.
    const fresh = seedProject(f.alice, CONTEXT('fresh'));
    // Listed and (impossibly) tombstoned: the list wins, it stays.
    f.alice.freeChats.push({ id: 'listed' });
    lists.addTombstone(f.alice.dir, 'listed');
    const listed = seedProject(f.alice, CONTEXT('listed'));
    const regular = seedProject(f.alice, 'proj-regular');
    // Bob's orphan with the same id is his workspace's business, not alice's sweep.
    lists.addTombstone(f.bob.dir, 'gone-1');
    const bobs = seedProject(f.bob, CONTEXT('gone-1'));

    assert.equal(f.store.removeOrphanChatContexts({ limit: 2 }), 2, 'bounded per call');
    assert.equal(f.store.removeOrphanChatContexts(), 1);
    assert.equal(f.store.removeOrphanChatContexts(), 0, 'idempotent');
    await tick();
    for (const o of orphans) assert.ok(noneExist(o.paths));
    assert.ok(allExist(fresh.paths) && allExist(listed.paths) && allExist(regular.paths));
    assert.deepEqual(f.alice.projects.map((p) => p.id), [CONTEXT('fresh'), CONTEXT('listed'), 'proj-regular']);
    assert.ok(allExist(bobs.paths));
    assert.deepEqual(f.bob.projects.map((p) => p.id), [CONTEXT('gone-1')]);
  } finally { f.cleanup(); }
});

test('Delete old chats (retention) removes expired chats\' attachments projects through the normal delete (#788)', async () => {
  const f = fixture();
  try {
    const retention = require('./chat-retention.cjs');
    const now = Date.now(), old = now - 100 * 86400000;
    f.alice.freeChats.push({ id: 'stale', updatedAt: old }, { id: 'pinned', updatedAt: old, pinned: true }, { id: 'recent', updatedAt: now });
    const host = seedProject(f.alice, 'proj-host', { chats: [{ id: 'stale-in-project', updatedAt: old }] });
    const stale = seedProject(f.alice, CONTEXT('stale'));
    const staleInProject = seedProject(f.alice, CONTEXT('stale-in-project'));
    const pinned = seedProject(f.alice, CONTEXT('pinned'));
    const recent = seedProject(f.alice, CONTEXT('recent'));
    // As index.cjs wires it: the visible lists, removed through deleteChat / deleteFreeChat.
    const visible = { freeChats: Array.from(f.alice.freeChats), projects: f.alice.projects.filter((p) => !p.id.startsWith('cowork-')) };
    for (const chat of retention.expired({ ...visible, days: 90, now })) {
      assert.equal(chat.projectId ? f.store.deleteChat(chat.projectId, chat.id) : f.store.deleteFreeChat(chat.id), true);
    }
    await tick();
    assert.ok(noneExist(stale.paths) && noneExist(staleInProject.paths));
    assert.ok(allExist(pinned.paths) && allExist(recent.paths) && allExist(host.paths));
  } finally { f.cleanup(); }
});
