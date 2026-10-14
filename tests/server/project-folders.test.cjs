const { test } = require('node:test');
const assert = require('node:assert/strict');
const { projectFolderName, createProjectFolder, reserveProjectFolder } = require('../../server/project-folders.cjs');

test('project folder names sanitize separators and traversal', () => {
  assert.equal(projectFolderName('Random questions'), 'Random questions');
  assert.equal(projectFolderName('../a\\b:*?"<>|\u0000'), '-a-b--------');
  assert.equal(projectFolderName('...'), 'Untitled project');
  assert.equal(projectFolderName(' x '.repeat(100)).length <= 80, true);
});
test('a folder is keyed by the project id, so a project name never appears in its path (#1458)', async () => {
  const folder = await createProjectFolder({async createFolder(){ return {existed:false}; }},{kind:'webdav'},'projects',{name:'Design',id:'proj-123-abc'});
  assert.equal(folder,'projects/proj-123-abc');
  const hostile = await createProjectFolder({async createFolder(){ return {existed:false}; }},{kind:'webdav'},'projects',{name:'x',id:'../a/b'});
  assert.equal(hostile,'projects/-a-b', 'an id is sanitized like a name: no separator or traversal reaches storage');
});
test('same-named projects get separate folders without any numbering', async () => {
  const paths = new Set();
  const storage = { async createFolder(_, path) { const existed = paths.has(path); paths.add(path); return {existed}; } };
  const result = await Promise.all(['proj-1','proj-2'].map(id=>createProjectFolder(storage,{kind:'webdav'},'noevia projects',{id,name:'Research'})));
  assert.deepEqual(result.sort(), ['noevia projects/proj-1','noevia projects/proj-2']);
});
test('a leftover folder with the same key is never adopted: the next free numbered one is used', async () => {
  const taken = { async createFolder(_c, f) { return { existed: f === 'root/proj-1' }; } };
  assert.equal(await createProjectFolder(taken, { kind: 'webdav' }, 'root', { id: 'proj-1', name: 'A' }), 'root/proj-1 (2)');
});
test('renaming a project does not change where its next folder would be allocated (#1458)', async () => {
  const made = [];
  const storage = { async createFolder(_c, f) { made.push(f); return { existed: false }; } };
  const project = { id: 'proj-9', name: 'Before' };
  project.name = 'After';
  assert.equal(await createProjectFolder(storage, { kind: 'webdav' }, 'root', project), 'root/proj-9');
});
test('storage failures propagate instead of claiming an existing location', async () => {
  await assert.rejects(createProjectFolder({async createFolder(){throw Error('offline');}},{kind:'webdav'},'projects',{name:'Design',id:'proj-1'}),/offline/);
});
test('S3 retains distinct prefixes because it cannot claim directories atomically, and they are keyed by id too', async () => {
  const storage = {createFolder(){throw Error('must not call');}};
  assert.equal(await createProjectFolder(storage,{kind:'s3'},'projects',{name:'Design',id:'proj-a'}),'projects/proj-a');
});
test('concurrent first uploads into one project share a single folder allocation', async () => {
  const project = {name:'Research',id:'proj-same'};
  const calls = [];
  const storage = {async createFolder(_,path){calls.push(path); return {existed:false};}};
  const paths = await Promise.all([1,2].map(()=>createProjectFolder(storage,{kind:'webdav'},'projects',project)));
  assert.deepEqual(paths,['projects/proj-same','projects/proj-same']);
  assert.deepEqual(calls,['projects','projects/proj-same']);
});

test('reserved folders are distinct without creating anything, and the first upload creates exactly the reserved path (#589)', async () => {
  const projects = [];
  const mk = (id) => { const p = { id, name: 'Design' }; p.reservedFolder = reserveProjectFolder({ kind: 'webdav' }, 'root', p, projects); projects.push(p); return p; };
  const [a, b] = [mk('a'), mk('b')];
  assert.deepEqual([a.reservedFolder, b.reservedFolder], ['root/a', 'root/b']);
  // A stored path that collides (an older project holding it) still gets the next free number.
  assert.equal(reserveProjectFolder({ kind: 'webdav' }, 'root', { id: 'a', name: 'Other' }, [{ id: 'z', projectFolder: 'root/a' }]), 'root/a (2)');
  const made = [];
  const storage = { async createFolder(_c, f) { made.push(f); return { existed: false }; } };
  assert.equal(await createProjectFolder(storage, { kind: 'webdav' }, 'root', b), 'root/b');
  // A reserved name someone else took meanwhile falls through to the next free one.
  const taken = { async createFolder(_c, f) { return { existed: f === 'root/c' }; } };
  assert.equal(await createProjectFolder(taken, { kind: 'webdav' }, 'root', { id: 'c', name: 'Design', reservedFolder: 'root/c' }), 'root/c (2)');
  // A legacy reservation made from the old name is still honoured: stored paths are never recomputed.
  assert.equal(await createProjectFolder(storage, { kind: 'webdav' }, 'root', { id: 'd', name: 'Design', reservedFolder: 'root/Design' }), 'root/Design');
});

test('ids that fit in 80 characters keep exactly the folder key they always had (#1653)', () => {
  const { projectFolderKey } = require('../../server/project-folders.cjs');
  for (const id of ['proj-123-abc', 'a', 'x'.repeat(80), '../a/b', 'with space.and.dots', 'Q4: plan?']) {
    assert.equal(projectFolderKey({ id, name: 'N' }), projectFolderName(id), `${id} is unchanged`);
  }
  assert.equal(projectFolderKey({ name: 'No id yet' }), 'No id yet');
});
test('two long ids sharing their first 80 characters no longer share a folder key (#1653)', async () => {
  const { projectFolderKey } = require('../../server/project-folders.cjs');
  const common = 'chat-context-'.padEnd(80, 'c');
  const a = projectFolderKey({ id: common + '-one' }), b = projectFolderKey({ id: common + '-two' });
  assert.notEqual(a, b);
  assert.equal(projectFolderName(common + '-one'), projectFolderName(common + '-two'), 'the old key collided');
  for (const key of [a, b]) { assert.ok(key.length <= 80); assert.match(key, /^[^/\\]+$/); }
  assert.equal(projectFolderKey({ id: common + '-one' }), a, 'stable for the same id');
  // Golden value, shared with noevia-web's storageFolderKeepsOldName test: changing the hash, its input or the
  // 67/12 split would move every long-id folder, so it must fail here first.
  assert.equal(projectFolderKey({ id: 'chat-context-'.padEnd(90, 'c') }), 'chat-context-cccccccccccccccccccccccccccccccccccccccccccccccccccccc-7912f25b6e6e');
  const s3 = {createFolder(){throw Error('must not call');}};
  assert.notEqual(await createProjectFolder(s3, { kind: 's3' }, 'projects', { id: common + '-one' }), await createProjectFolder(s3, { kind: 's3' }, 'projects', { id: common + '-two' }));
  assert.equal(reserveProjectFolder({ kind: 's3' }, 'projects', { id: common + '-one' }, []), `projects/${a}`);
});
test('an S3 project reserved under the old truncated key keeps that prefix on its first upload (#1653)', async () => {
  const common = 'chat-context-'.padEnd(80, 'c');
  const s3 = {createFolder(){throw Error('must not call');}};
  const legacy = `projects/${projectFolderName(common + '-one')}`;
  assert.equal(await createProjectFolder(s3, { kind: 's3' }, 'projects', { id: common + '-one', reservedFolder: legacy }), legacy);
});
