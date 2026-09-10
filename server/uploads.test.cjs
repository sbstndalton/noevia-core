'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const uploads = require('./uploads.cjs');
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-upload-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { workspace: { dir, assetDir: id => path.join(dir, 'assets', id) }, project: { id: 'synthetic', projectFolder: 'projects/synthetic', files: [], assets: [] } };
}
test('file policy accepts opaque documents and rejects archive bundles, unsafe names and oversized input', () => {
  const zip = Buffer.from([0x50,0x4b,3,4,1]);
  assert.doesNotThrow(() => uploads.validate('fixture.docx', zip));
  for (const name of ['fixture.zip','fixture.txt','../bad','bad\\path']) assert.throws(() => uploads.validate(name, zip));
  assert.throws(() => uploads.validate('big.bin', Buffer.alloc(uploads.CAP + 1)), /25 MB/);
  assert.equal(uploads.classify('fixture.DOCX'), 'Documents');
  assert.equal(uploads.classify('fixture.png'), 'Images');
  assert.equal(uploads.classify('fixture.txt'), 'Text');
  assert.equal(uploads.classify('fixture.bin'), 'Other');
});
test('all original bytes including images and DOCX use type folders in configured storage', async t => {
  const { workspace, project } = setup(t); const writes = [], stages = [];
  const storageImpl = { createFolder: async (_c, p) => writes.push(['folder',p]), writeFile: async (_c,p,b) => writes.push(['file',p,Buffer.from(b)]) };
  for (const [name, group] of [['fixture.docx','Documents'],['fixture.png','Images'],['fixture.txt','Text'],['fixture.bin','Other']]) {
    const bytes = Buffer.from('synthetic original');
    const file = await uploads.ingest(workspace, project, name, bytes, { connection: {}, storageImpl, progress: x => stages.push(x) });
    project.files.push(file);
    assert.equal(file.name, `projects/synthetic/${group}/${name}`);
    assert.deepEqual(fs.readFileSync(uploads.original(workspace, project.id, file)), bytes);
    assert.deepEqual(writes.at(-1), ['file',file.name,bytes]);
  }
  assert.equal(project.assets[0].storagePath, 'projects/synthetic/Images/fixture.png');
  assert.equal(project.files[0].attachment.state, 'stored'); assert.equal(project.files[0].content, '');
  assert.ok(stages.includes('Saving to Nextcloud / storage'));
});
test('storage failures never claim a successful local fallback', async t => {
  const { workspace, project } = setup(t);
  await assert.rejects(uploads.ingest(workspace, project, 'fixture.docx', Buffer.from('synthetic'), { connection: {}, storageImpl: { createFolder: async () => {}, writeFile: async () => { throw new Error('offline'); } } }), /offline/);
  assert.equal(project.files.length, 0); assert.equal(project.assets.length, 0);
});
test('local originals are project-scoped and pruning preserves referenced data only', async t => {
  const { workspace, project } = setup(t);
  const file = await uploads.ingest(workspace, project, 'fixture.png', Buffer.from('synthetic'));
  project.files.push(file);
  assert.notEqual(uploads.original(workspace, project.id, file), uploads.original(workspace, 'other', file));
  assert.equal(fs.existsSync(uploads.original(workspace, 'other', file)), false);
  uploads.prune(workspace, project); assert.equal(project.assets.length, 1);
  project.files = []; uploads.prune(workspace, project);
  assert.equal(fs.existsSync(uploads.original(workspace, project.id, file)), false); assert.equal(project.assets.length, 0);
});
