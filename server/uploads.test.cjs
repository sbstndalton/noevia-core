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

test('replacing an image above the vision limit retires old model input and can later restore vision', async t => {
  const { workspace, project } = setup(t);
  const small = await uploads.ingest(workspace, project, 'fixture.png', Buffer.from('synthetic small image'));
  project.files = [small];
  const oldAsset = project.assets[0].id;
  const large = await uploads.ingest(workspace, project, 'fixture.png', Buffer.alloc(9 * 1024 * 1024, 1));
  project.files = [large];
  assert.equal(large.attachment.state, 'stored');
  assert.deepEqual(project.assets, []);
  uploads.prune(workspace, project);
  assert.equal(fs.existsSync(path.join(workspace.assetDir(project.id), oldAsset)), false);
  const replacement = await uploads.ingest(workspace, project, 'fixture.png', Buffer.from('synthetic replacement image'));
  project.files = [replacement];
  assert.equal(replacement.attachment.state, 'vision');
  assert.equal(project.assets.length, 1);
  assert.notEqual(project.assets[0].id, oldAsset);
});
test('DOCX extracts bounded body text while keeping tenant-owned originals and honest limitations', async t => {
  const {workspace,project}=setup(t),bytes=Buffer.from('synthetic docx');let calls=0;
  const extractDocx=async data=>{calls++;assert.deepEqual(data,bytes);return {text:'Synthetic refund -7.20',truncated:false};};
  const file=await uploads.ingest(workspace,project,'fixture.docx',bytes,{extractDocx});
  assert.equal(file.attachment.state,'partial');assert.match(file.content,/Synthetic refund -7.20/);
  assert.match(file.content,/page|layout/);assert.match(file.attachment.reason,/footnotes/);
  assert.deepEqual(fs.readFileSync(uploads.original(workspace,project.id,file)),bytes);
  project.files.push(file);
  const cached=await uploads.ingest(workspace,project,'fixture.docx',bytes,{extractDocx});
  assert.equal(calls,1);assert.equal(cached.content,file.content);
});
test('failed DOCX replacement retains its original and clears previous readable content', async t => {
  const {workspace,project}=setup(t);
  project.files.push(await uploads.ingest(workspace,project,'fixture.docx',Buffer.from('old'),{extractDocx:async()=>({text:'OLD PRIVATE TEXT',truncated:false})}));
  const file=await uploads.ingest(workspace,project,'fixture.docx',Buffer.from('new invalid'),{extractDocx:async()=>{throw Error('Synthetic parse failure');}});
  assert.equal(file.content,'');assert.equal(file.attachment.state,'stored');assert.match(file.attachment.reason,/parse failure/);
  assert.equal(fs.readFileSync(uploads.original(workspace,project.id,file),'utf8'),'new invalid');
});
