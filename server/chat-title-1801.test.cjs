'use strict';
// #1801: saving a generated chat title (projects.cjs setChatTitle) changes the title only. The chat's
// updatedAt and preview, including ones another writer (the Rust projects front, M4) saved to disk
// since this process last read the list, are kept. Synthetic chats only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createProjectStore } = require('./projects.cjs');
const rustProjects = require('./rust-projects.cjs');
const titles = require('./chat-title.cjs');

const FIRST = 'Hello there, can you help me plan a synthetic picnic?';
const DERIVED = titles.derivedTitle(FIRST);
const T0 = 1_800_000_000_000;
const T1 = T0 + 60_000;

const atomicJson = (file, value) => { const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(value)); fs.renameSync(tmp, file); };
// #1264: the coordinated files are written through the Rust project store (a stand-in here).
const { remoteFor } = require('../tests/server/project-store-stub.cjs');

function setup(t, { coordinated, afterRead = null }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-1801-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const freeFile = path.join(dir, 'free-chats.json');
  const projectsFile = path.join(dir, 'projects.json');
  atomicJson(freeFile, [{ id: 'f1', title: DERIVED, updatedAt: T0, preview: 'older line' }]);
  atomicJson(projectsFile, { projects: [{ id: 'p1', name: 'P', chats: [{ id: 'c1', title: DERIVED, updatedAt: T0, preview: 'older line' }] }] });
  const remote = coordinated ? remoteFor(dir) : null;
  if (remote && afterRead) {
    // The other writer lands between this save's read of the store and its write.
    const read = remote.client.read;
    remote.client.read = async (user, file) => { const r = await read(user, file); afterRead(file); return r; };
  }
  const free = coordinated ? rustProjects.createFreeChatsFile(freeFile, { remote }) : null;
  const proj = coordinated ? rustProjects.createProjectsFile(projectsFile, { remote }) : null;
  const saves = [];
  const ws = {
    userId: 'synthetic-user', dir, freeChatsFile: free, projectsFile: proj ? { refresh: (l) => proj.refresh(l), save: (l) => proj.save(l) } : null,
    projects: proj ? proj.load() : JSON.parse(fs.readFileSync(projectsFile, 'utf8')).projects,
    freeChats: free ? free.load() : JSON.parse(fs.readFileSync(freeFile, 'utf8')),
    saveProjects() { if (proj) saves.push(proj.save(this.projects)); else atomicJson(projectsFile, { projects: this.projects }); },
    saveFreeChats() { if (free) saves.push(free.save(this)); else atomicJson(freeFile, this.freeChats); },
  };
  const view = (field) => new Proxy([], {
    get(_t, prop) { const v = ws[field][prop]; return typeof v === 'function' ? v.bind(ws[field]) : v; },
    set(_t, prop, value) { ws[field][prop] = value; return true; },
    ownKeys() { return Reflect.ownKeys(ws[field]); },
    getOwnPropertyDescriptor(_t, prop) { const d = Reflect.getOwnPropertyDescriptor(ws[field], prop); return d && { ...d, configurable: true }; },
  });
  const store = createProjectStore({ fs, path, reasoningEffort: { validEffort: () => true }, projectAppearance: () => ({}), rag: {}, storageClient: { isBrowsable: () => false },
    documentSources: {}, authService: {}, currentWorkspace: () => ws, PROJECTS: view('projects'), FREE_CHATS: view('freeChats'),
    sanitizeToolboxes: (b) => b, defaultToolboxes: () => ['core'], PROJECT_ROOT_FOLDER: 'root', createProjectFolder: async () => null, projectSweep: { afterDelete: async () => {} } });
  const disk = {
    free: () => JSON.parse(fs.readFileSync(freeFile, 'utf8')).find((c) => c.id === 'f1'),
    project: () => JSON.parse(fs.readFileSync(projectsFile, 'utf8')).projects[0].chats.find((c) => c.id === 'c1'),
  };
  return { ws, store, disk, freeFile, projectsFile, flush: () => Promise.all(saves) };
}

test('#1801: setChatTitle changes only the title; updatedAt and preview survive, including a front save that lands mid-save', async (t) => {
  // Controls (these held before the fix): Node-owned lists, and a front save before the re-read.
  const plainLists = setup(t, { coordinated: false });
  plainLists.ws.freeChats[0].updatedAt = T1; plainLists.ws.freeChats[0].preview = 'latest line';
  plainLists.ws.projects[0].chats[0].updatedAt = T1; plainLists.ws.projects[0].chats[0].preview = 'latest line';
  assert.equal(plainLists.store.setChatTitle(null, 'f1', 'Picnic Plan', FIRST), true);
  assert.equal(plainLists.store.setChatTitle('p1', 'c1', 'Picnic Plan', FIRST), true);
  assert.deepEqual(plainLists.disk.free(), { id: 'f1', title: 'Picnic Plan', updatedAt: T1, preview: 'latest line' });
  assert.deepEqual(plainLists.disk.project(), { id: 'c1', title: 'Picnic Plan', updatedAt: T1, preview: 'latest line' });

  const before = setup(t, { coordinated: true });
  atomicJson(before.freeFile, [{ id: 'f1', title: DERIVED, updatedAt: T1, preview: 'latest line' }]);
  atomicJson(before.projectsFile, { projects: [{ id: 'p1', name: 'P', chats: [{ id: 'c1', title: DERIVED, updatedAt: T1, preview: 'latest line' }] }] });
  assert.equal(before.store.setChatTitle(null, 'f1', 'Picnic Plan', FIRST), true);
  assert.equal(before.store.setChatTitle('p1', 'c1', 'Picnic Plan', FIRST), true);
  await before.flush();
  assert.deepEqual(before.disk.free(), { id: 'f1', title: 'Picnic Plan', updatedAt: T1, preview: 'latest line' });
  assert.deepEqual(before.disk.project(), { id: 'c1', title: 'Picnic Plan', updatedAt: T1, preview: 'latest line' });

  // The bug: the front's write lands after setChatTitle re-read the lists but before its locked save
  // reads them; the meta changed on both sides was replaced whole by this process's stale copy.
  const front = { 'free-chats.json': true, 'projects.json': true };
  const f = setup(t, { coordinated: true, afterRead: (file) => {
    if (!front[file]) return;
    front[file] = false;
    if (file === 'free-chats.json') atomicJson(f.freeFile, [{ id: 'f1', title: DERIVED, updatedAt: T1, preview: 'latest line' }]);
    else atomicJson(f.projectsFile, { projects: [{ id: 'p1', name: 'P', chats: [{ id: 'c1', title: DERIVED, updatedAt: T1, preview: 'latest line' }] }] });
  } });
  assert.equal(f.store.setChatTitle(null, 'f1', 'Picnic Plan', FIRST), true);
  assert.equal(f.store.setChatTitle('p1', 'c1', 'Picnic Plan', FIRST), true);
  await f.flush();
  assert.deepEqual(f.disk.free(), { id: 'f1', title: 'Picnic Plan', updatedAt: T1, preview: 'latest line' });
  assert.deepEqual(f.disk.project(), { id: 'c1', title: 'Picnic Plan', updatedAt: T1, preview: 'latest line' });
  assert.deepEqual(f.ws.freeChats[0], { id: 'f1', title: 'Picnic Plan', updatedAt: T1, preview: 'latest line' }, 'this process sees the merged meta too');
});

test('#1801: a meta both sides changed keeps both changes; a field both changed is this process\'s', () => {
  const { mergeIdList: mergeIdListForTest } = require('./rust-projects.cjs');
  const base = [{ id: 'a', title: 'T', updatedAt: 1, preview: 'p0' }];
  const ours = [{ id: 'a', title: 'Mine', updatedAt: 1, preview: 'p-mine' }];
  const theirs = [{ id: 'a', title: 'T', updatedAt: 2, preview: 'p-theirs' }];
  assert.deepEqual(mergeIdListForTest(ours, base, theirs), [{ id: 'a', title: 'Mine', updatedAt: 2, preview: 'p-mine' }]);
});

// #1801 review: the per-field merge applies to every id-keyed list of a project (assets, retiredAssets,
// chats). Kept on purpose: the Rust front re-reads projects.json under the lock and changes only the
// fields it serves, so what is on disk is exactly its change; per field, neither side's edit is lost.
const P = (fields) => ({ id: 'p1', name: 'P', ...fields });
const mergeProject = (ours, base, disk) => {
  const { merge } = require('./rust-projects.cjs');
  const baseMap = new Map([['p1', JSON.stringify(base)]]);
  return merge([ours], baseMap, [disk]).result[0];
};

test('#1801 review: an asset changed on both sides keeps both changes (assets and retiredAssets)', () => {
  const base = P({ assets: [{ id: 'a1', name: 'scan.png', status: 'pending' }], retiredAssets: [{ id: 'r1', name: 'old.png', note: '' }] });
  const ours = P({ assets: [{ id: 'a1', name: 'renamed.png', status: 'pending' }], retiredAssets: [{ id: 'r1', name: 'old.png', note: 'kept' }] });
  const disk = P({ assets: [{ id: 'a1', name: 'scan.png', status: 'indexed' }], retiredAssets: [{ id: 'r1', name: 'old.png', note: '', retiredAt: 7 }] });
  const out = mergeProject(ours, base, disk);
  assert.deepEqual(out.assets, [{ id: 'a1', name: 'renamed.png', status: 'indexed' }]);
  assert.deepEqual(out.retiredAssets, [{ id: 'r1', name: 'old.png', note: 'kept', retiredAt: 7 }]);
});

test('#1801 review: a chat the front archived keeps the archive and the title saved here', () => {
  const base = P({ chats: [{ id: 'c1', title: DERIVED, updatedAt: T0 }] });
  const ours = P({ chats: [{ id: 'c1', title: 'Picnic Plan', updatedAt: T0 }] });
  const disk = P({ chats: [{ id: 'c1', title: DERIVED, updatedAt: T0, archived: true }] });
  assert.deepEqual(mergeProject(ours, base, disk).chats, [{ id: 'c1', title: 'Picnic Plan', updatedAt: T0, archived: true }]);
  // Un-archived here while the front changed the preview: both stand.
  const base2 = P({ chats: [{ id: 'c1', title: 'T', archived: true, preview: 'p0' }] });
  const ours2 = P({ chats: [{ id: 'c1', title: 'T', preview: 'p0' }] });
  const disk2 = P({ chats: [{ id: 'c1', title: 'T', archived: true, preview: 'p1' }] });
  assert.deepEqual(mergeProject(ours2, base2, disk2).chats, [{ id: 'c1', title: 'T', preview: 'p1' }]);
});

test('#1801 review: a deleted entry stays deleted on either side, even if the other side changed it', () => {
  const base = P({ chats: [{ id: 'c1', title: 'one' }, { id: 'c2', title: 'two' }, { id: 'c3', title: 'three' }] });
  const ours = P({ chats: [{ id: 'c1', title: 'one, edited here' }, { id: 'c3', title: 'three, edited here' }] }); // c2 deleted here
  const disk = P({ chats: [{ id: 'c1', title: 'one', preview: 'front' }, { id: 'c2', title: 'two, edited there' }] }); // c3 deleted there
  assert.deepEqual(mergeProject(ours, base, disk).chats, [{ id: 'c1', title: 'one, edited here', preview: 'front' }]);
});

test('#1801 review: the same field changed on both sides is this process\'s; the other side\'s other fields stay', () => {
  const base = P({ chats: [{ id: 'c1', title: 'T', updatedAt: 1, preview: 'p0' }] });
  const ours = P({ chats: [{ id: 'c1', title: 'Here', updatedAt: 1, preview: 'p0' }] });
  const disk = P({ chats: [{ id: 'c1', title: 'There', updatedAt: 2, preview: 'p1' }] });
  assert.deepEqual(mergeProject(ours, base, disk).chats, [{ id: 'c1', title: 'Here', updatedAt: 2, preview: 'p1' }]);
});
