const { test } = require('node:test');
const assert = require('node:assert/strict');
const { projectFolderName, createProjectFolder, reserveProjectFolder } = require('../../server/project-folders.cjs');

test('readable project folders sanitize separators and traversal without embedding IDs', () => {
  assert.equal(projectFolderName('Random questions'), 'Random questions');
  assert.equal(projectFolderName('../a\\b:*?"<>|\u0000'), '-a-b--------');
  assert.equal(projectFolderName('...'), 'Untitled project');
  assert.equal(projectFolderName(' x '.repeat(100)).length <= 80, true);
});
test('existing folders and concurrent same-name projects receive separate numbered folders', async () => {
  const paths = new Set(['noevia projects/Research']);
  const storage = { async createFolder(_, path) {
    const existed = paths.has(path); paths.add(path); return {existed};
  }};
  const result = await Promise.all([1,2].map(id=>createProjectFolder(storage,{kind:'webdav'},'noevia projects',{id,name:'Research'})));
  assert.deepEqual(result.sort(), ['noevia projects/Research (2)','noevia projects/Research (3)']);
});
test('an available folder uses only the project name', async () => {
  const folder = await createProjectFolder({async createFolder(){ return {existed:false}; }},{kind:'webdav'},'projects',{name:'Design',id:'proj-123'});
  assert.equal(folder,'projects/Design');
});
test('storage failures propagate instead of claiming an existing location', async () => {
  await assert.rejects(createProjectFolder({async createFolder(){throw Error('offline');}},{kind:'webdav'},'projects',{name:'Design'}),/offline/);
});
test('S3 retains distinct prefixes because it cannot claim directories atomically', async () => {
  const storage = {createFolder(){throw Error('must not call');}};
  assert.equal(await createProjectFolder(storage,{kind:'s3'},'projects',{name:'Design',id:'proj-a'}),'projects/Design--proj-a');
});
test('concurrent first uploads into one project share a single folder allocation', async () => {
  const project = {name:'Research',id:'proj-same'};
  const calls = [];
  const storage = {async createFolder(_,path){calls.push(path); return {existed:false};}};
  const paths = await Promise.all([1,2].map(()=>createProjectFolder(storage,{kind:'webdav'},'projects',project)));
  assert.deepEqual(paths,['projects/Research','projects/Research']);
  assert.deepEqual(calls,['projects','projects/Research']);
});

test('reserved folders are distinct without creating anything, and the first upload creates exactly the reserved path (#589)', async () => {
  const projects = [];
  const mk = (id) => { const p = { id, name: 'Design' }; p.reservedFolder = reserveProjectFolder({ kind: 'webdav' }, 'root', p, projects); projects.push(p); return p; };
  const [a, b] = [mk('a'), mk('b')];
  assert.deepEqual([a.reservedFolder, b.reservedFolder], ['root/Design', 'root/Design (2)']);
  const made = [];
  const storage = { async createFolder(_c, f) { made.push(f); return { existed: false }; } };
  assert.equal(await createProjectFolder(storage, { kind: 'webdav' }, 'root', b), 'root/Design (2)');
  // A reserved name someone else took meanwhile falls through to the next free one.
  const taken = { async createFolder(_c, f) { return { existed: f === 'root/Design' }; } };
  assert.equal(await createProjectFolder(taken, { kind: 'webdav' }, 'root', { id: 'c', name: 'Design', reservedFolder: 'root/Design' }), 'root/Design (2)');
});
