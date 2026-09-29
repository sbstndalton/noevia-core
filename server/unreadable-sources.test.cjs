'use strict';
// #586: an unreadable upload is kept as an original but is never indexed, offered to the model or
// cited. #589: a project's storage folder is created on the first upload, not with the project.
// Synthetic fixtures only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const uploads = require('./uploads.cjs');
const skills = require('./instruction-skills.cjs');
const { isUnreadable } = require('./source-readability.cjs');
const { buildSources } = require('./chat-sources.cjs');
const { createProjectStore } = require('./projects.cjs');
const { createProjectRoutes } = require('./routes/projects.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-unreadable-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const workspace = () => ({ dir: root, assetDir: (id) => path.join(root, 'assets', id), userId: 'synthetic-user', assertActive() {} });
const binary = Buffer.concat([Buffer.alloc(64, 0), Buffer.from('opaque bytes')]);

async function unreadableFile() {
  const project = { id: 'p-unreadable', files: [], assets: [] };
  return uploads.ingest(workspace(), project, 'broken.txt', binary);
}

test('a binary file behind a .txt name ingests as an unreadable original', async () => {
  const file = await unreadableFile();
  assert.equal(file.attachment.state, 'stored');
  assert.equal(file.content, '');
  assert.equal(isUnreadable(file), true);
  assert.equal(isUnreadable({ name: 'ok.txt', content: 'hello', attachment: { state: 'ready', group: 'Text' } }), false);
  // A failed refresh that still holds earlier text is readable; a failed first read is not.
  assert.equal(isUnreadable({ name: 'a.pdf', content: 'earlier text', document: { state: 'failed', stale: true } }), false);
  assert.equal(isUnreadable({ name: 'a.pdf', content: '', document: { state: 'failed' } }), true);
  // Images and other stored originals are not text sources but are not "unreadable text" either.
  assert.equal(isUnreadable({ name: 'a.png', content: '', attachment: { state: 'vision', group: 'Images' } }), false);
});

test('an unreadable file is not indexed and its earlier index entries are removed', async () => {
  const file = await unreadableFile();
  const calls = [];
  const rag = { indexProjectFile: async (...a) => { calls.push(['index', a[1]]); return { ok: true }; }, deleteProjectFile: (...a) => calls.push(['delete', a[1]]) };
  const w = { ...workspace(), projects: [], saveProjects() {} };
  const store = createProjectStore({ fs, path, currentWorkspace: () => w, rag, PROJECTS: [], FREE_CHATS: [], storageClient: {}, authService: {}, documentSources: {},
    reasoningEffort: {}, projectAppearance: () => ({}), sanitizeToolboxes: () => [], defaultToolboxes: () => [], PROJECT_ROOT_FOLDER: 'p', createProjectFolder: async () => null, projectSweep: {} });
  store.indexSource({ id: 'p', files: [file] }, file);
  store.indexSource({ id: 'p', files: [] }, { name: 'ok.txt', content: 'readable text' });
  assert.deepEqual(calls, [['delete', 'broken.txt'], ['index', 'ok.txt']]);
});

test('chat context never offers or cites an unreadable file', async () => {
  const bad = await unreadableFile();
  const good = { name: 'notes.txt', content: 'Quarterly plan: ship the synthetic widget.', attachment: { state: 'ready', group: 'Text', id: 'a'.repeat(64) } };
  const project = { id: 'p', files: [bad, good] };
  assert.deepEqual(skills.sources(project).map((f) => f.name), ['notes.txt']);
  // The same slice-and-run approach as the other filesContext tests, over the files chat passes in.
  const src = fs.readFileSync(require.resolve('./rag.cjs'), 'utf8');
  const body = src.slice(src.indexOf('async function filesContext('), src.indexOf('\nmodule.exports'));
  const context = { DIRECT_INJECT_MAX: 2400, FILES_CONTEXT_MAX_CHARS: 120000, LARGE_FILE_HEAD: 24000, documentNotice: () => '',
    frameUntrusted: require('./prompt-framing.cjs').frameUntrusted, ragAvailable: () => false, searchProject: async () => [] };
  vm.createContext(context); vm.runInContext(body, context);
  let placed = [];
  const text = await context.filesContext('p', skills.sources(project), 'plan', 'u', (p) => { placed = p; });
  assert.ok(!text.includes('broken.txt'));
  assert.deepEqual(Array.from(placed, (p) => p.file), ['notes.txt']);
  // Defence in depth: even if a caller hands the unreadable file to the citation builder, it is dropped.
  assert.deepEqual(buildSources([{ file: 'broken.txt', body: '', kind: 'file' }, { file: 'notes.txt', body: 'x', kind: 'file' }], project.files).map((s) => s.file), ['notes.txt']);
});

// ── #589 ────────────────────────────────────────────────────────────────────
function lazyHarness() {
  const created = [], written = [];
  const conn = { kind: 'webdav' };
  const storageClient = { TEXT_EXTENSIONS: new Set(['.txt']), isBrowsable: () => true, writeFile: async (_c, name) => { written.push(name); }, createFolder: async () => ({ existed: false }) };
  const w = { ...workspace(), projects: [], saveProjects() {} };
  const PROJECTS = w.projects;
  const shared = { fs, path, storageClient, authService: { getStorage: () => conn }, currentWorkspace: () => w, PROJECTS, rag: { indexProjectFile: async () => ({ ok: true }), deleteProjectFile() {} }, documentSources: {} };
  const store = createProjectStore({ ...shared, FREE_CHATS: [], reasoningEffort: {}, projectAppearance: () => ({}), sanitizeToolboxes: () => [], defaultToolboxes: () => [], PROJECT_ROOT_FOLDER: 'noevia projects',
    createProjectFolder: async (_s, _c, _r, project) => { created.push(project.name); return `noevia projects/${project.name}`; }, projectSweep: { afterDelete: async () => {} } });
  let last;
  const routes = createProjectRoutes({ ...shared, store, requestScope: { getStore: () => ({}) }, dispatch: async () => {}, readJson: async (req) => req.body,
    readBody: async (req) => JSON.stringify(req.body), json: (_r, status, body) => { last = { status, body }; },
    documents: require('./documents.cjs'), reasoningEffort: {}, projectAppearance: () => ({}), diaryExtras: {}, DEFAULT_TOOLBOXES: [], sanitizeToolboxes: () => null, getProvider: () => null, ensureRolesLoaded: () => {} });
  const upload = async (project, name, text) => { last = undefined; const p = `/api/projects/${project.id}/upload`;
    await routes({ method: 'POST', body: { name, dataBase64: Buffer.from(text).toString('base64') } }, {}, { path: p, authn: { user: { id: 'synthetic-user' } }, url: new URL('http://localhost' + p) }); return last; };
  return { store, created, written, upload };
}

test('creating a project makes no storage folder; the first upload creates it once', async () => {
  const h = lazyHarness();
  const project = await h.store.createProject({ name: 'Never used' });
  assert.deepEqual(h.created, []);
  assert.equal(project.projectFolder, undefined);
  assert.deepEqual(project.sourceFolders, []);
  assert.equal((await h.upload(project, 'a.txt', 'first')).status, 200);
  assert.deepEqual(h.created, ['Never used']);
  assert.equal(project.projectFolder, 'noevia projects/Never used');
  assert.deepEqual(project.sourceFolders, ['noevia projects/Never used']);
  assert.equal((await h.upload(project, 'b.txt', 'second')).status, 200);
  assert.deepEqual(h.created, ['Never used']);
  assert.deepEqual(h.written, ['noevia projects/Never used/a.txt', 'noevia projects/Never used/b.txt']);
});

test('a skill uploaded to the project folder is not reported as from an attached folder (#588)', () => {
  const content = '---\nname: synthetic\ndescription: d\nversion: 1\n---\nBody';
  const file = (source) => ({ name: 'noevia projects/P/Text/SKILL.md', content, ...(source ? { source } : {}) });
  const origin = (project) => skills.manifests(project, ['core'])[0].origin.kind;
  const own = { id: 'p', projectFolder: 'noevia projects/P', files: [file('noevia projects/P')] };
  const linked = { id: 'p', projectFolder: 'noevia projects/P', files: [file('Reference notes')] };
  const local = { id: 'p', files: [file()] };
  for (const p of [own, linked, local]) skills.reconcile(p);
  assert.equal(origin(own), 'project-file');
  assert.equal(origin(linked), 'attached-folder');
  assert.equal(origin(local), 'project-file');
});
