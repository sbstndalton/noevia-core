'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { AsyncLocalStorage } = require('node:async_hooks');
const { createWorkspaceStore } = require('./workspace.cjs');
const { createProjectStore } = require('./projects.cjs');
const { createProjectRoutes } = require('./routes/projects.cjs');
const documents = require('./documents.cjs');
const documentSources = require('./document-sources.cjs');

const DELETED_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const OTHER_ID = 'bbbbbbbb-2222-4222-8222-222222222222';
const extracted = { text: 'synthetic extracted text', pages: 1, pageTexts: [{ number: 1, status: 'native', text: 'synthetic extracted text' }], state: 'ready', truncated: false };
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-account-deletion-source-'));
  const workspaces = createWorkspaceStore(root, { id: 'default', label: 'Default', apiKey: '' });
  const workspace = workspaces.get(DELETED_ID);
  workspace.projects = [{ id: 'p1', name: 'Synthetic', files: [], chats: [] }];
  workspace.saveProjects();
  const other = workspaces.get(OTHER_ID);
  other.projects = [{ id: 'p2', name: 'Other', files: [], chats: [] }];
  other.saveProjects();
  const scope = new AsyncLocalStorage();
  const currentWorkspace = () => scope.getStore().workspace;
  const rag = { indexProjectFile: async () => ({ ok: true, direct: true, stored: 1, embedded: 0 }), deleteProjectFile() {} };
  const store = createProjectStore({
    fs, path, currentWorkspace, rag, documentSources,
    PROJECTS: workspace.projects, FREE_CHATS: workspace.freeChats,
    reasoningEffort: { validEffort: () => true }, projectAppearance: () => ({}),
    storageClient: { isBrowsable: () => false }, authService: { getStorage: () => ({ kind: 'local' }) },
    sanitizeToolboxes: () => [], defaultToolboxes: () => [], PROJECT_ROOT_FOLDER: 'projects',
    createProjectFolder: async () => null, projectSweep: { afterDelete: async () => {} },
  });
  const replies = [];
  const routes = createProjectRoutes({
    json: (_res, status, body) => { replies.push({ status, body }); },
    readBody: async (req) => { let body = ''; for await (const chunk of req) body += chunk; return body; },
    readJson: async () => ({}), requestScope: scope, dispatch: async () => {}, currentWorkspace,
    authService: { getStorage: () => ({ kind: 'local' }), diaryEnabled: () => false },
    storageClient: { isBrowsable: () => false, TEXT_EXTENSIONS: new Set(['.txt']) },
    documents, documentSources, rag, fs, path,
    reasoningEffort: { validEffort: () => true }, projectAppearance: () => ({}),
    diaryExtras: { PROJECT_ID: 'diary', chatProjectId: () => null, newProject: () => ({}) },
    PROJECTS: workspace.projects, DEFAULT_TOOLBOXES: [], sanitizeToolboxes: () => [],
    getProvider: () => null, ensureRolesLoaded() {}, servedCatalogue: async () => [],
    DEFAULT_PROVIDER_ID: 'default', store,
  });
  const upload = (bytes) => {
    const url = '/api/projects/p1/documents';
    const req = Readable.from([JSON.stringify({ name: 'synthetic.pdf', dataBase64: bytes.toString('base64') })]);
    Object.assign(req, { method: 'POST', url, headers: {} });
    return scope.run({ workspace }, () => routes(req, {}, { path: url, authn: { user: { id: DELETED_ID } }, url: new URL(`http://localhost${url}`) }));
  };
  return { root, workspaces, workspace, other, replies, upload };
}

test('account deletion fences a held document extraction before result or project metadata can return', async () => {
  const f = fixture();
  const entered = deferred(), release = deferred();
  const original = documents.extractDocumentText;
  documents.extractDocumentText = async () => { entered.resolve(); await release.promise; return extracted; };
  try {
    const pending = f.upload(Buffer.from('%PDF synthetic deleted upload'));
    await entered.promise;
    assert.ok(fs.existsSync(documentSources.directory(f.workspace, 'p1')), 'original bytes landed before extraction paused');
    f.workspaces.remove(DELETED_ID);
    assert.equal(fs.existsSync(f.workspace.dir), false);
    release.resolve();
    await assert.rejects(pending, (error) => error.status === 410);
    assert.equal(fs.existsSync(f.workspace.dir), false, 'neither extracted data nor projects.json is recreated');
    assert.equal(f.replies.length, 0, 'the deleted account never receives a successful upload reply');
    assert.throws(() => f.workspace.saveProjects(), (error) => error.status === 410);
    assert.throws(() => f.workspaces.get(DELETED_ID), (error) => error.status === 410);
    assert.equal(fs.existsSync(f.workspace.dir), false);
    assert.ok(fs.existsSync(path.join(f.other.dir, 'projects.json')), 'another tenant remains intact');
  } finally {
    release.resolve();
    documents.extractDocumentText = original;
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('an active account still saves document originals, extraction and project metadata', async () => {
  const f = fixture();
  const original = documents.extractDocumentText;
  documents.extractDocumentText = async () => extracted;
  try {
    await f.upload(Buffer.from('%PDF synthetic active upload'));
    assert.equal(f.replies.at(-1)?.status, 200);
    const files = fs.readdirSync(documentSources.directory(f.workspace, 'p1'));
    assert.ok(files.some((name) => name.endsWith('.pdf')));
    assert.ok(files.some((name) => name.endsWith('.json')));
    const saved = JSON.parse(fs.readFileSync(path.join(f.workspace.dir, 'projects.json'), 'utf8'));
    assert.equal(saved.projects[0].files[0].name, 'synthetic.pdf');
    assert.ok(fs.existsSync(path.join(f.other.dir, 'projects.json')));
  } finally {
    documents.extractDocumentText = original;
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('a detached source job cannot recreate its journal or extracted source after account deletion', async () => {
  const f = fixture();
  const entered = deferred(), release = deferred(), completed = deferred();
  const original = documents.extractDocumentText;
  documents.extractDocumentText = async () => { entered.resolve(); await release.promise; return extracted; };
  try {
    const jobs = require('./source-jobs.cjs');
    jobs.start(f.workspace, 'p1', async () => {
      try { await documentSources.ingest(f.workspace, 'p1', 'background.pdf', Buffer.from('%PDF synthetic background'), null); }
      finally { completed.resolve(); }
      return { status: 200, body: { ok: true } };
    });
    await entered.promise;
    assert.ok(fs.existsSync(documentSources.directory(f.workspace, 'p1')));
    f.workspaces.remove(DELETED_ID);
    release.resolve();
    await completed.promise;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fs.existsSync(f.workspace.dir), false);
  } finally {
    release.resolve();
    documents.extractDocumentText = original;
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('an organized upload waiting on storage cannot recreate original or image asset files', async () => {
  const f = fixture();
  const entered = deferred(), release = deferred();
  try {
    const project = { id: 'p1', projectFolder: 'Synthetic', files: [], assets: [] };
    const pending = require('./uploads.cjs').ingest(f.workspace, project, 'synthetic.png', Buffer.from('synthetic image bytes'), {
      connection: { kind: 'webdav' },
      storageImpl: {
        createFolder: async () => { entered.resolve(); await release.promise; },
        writeFile: async () => { throw new Error('remote write should not begin after deletion'); },
      },
    });
    await entered.promise;
    f.workspaces.remove(DELETED_ID);
    release.resolve();
    await assert.rejects(pending, (error) => error.status === 410);
    assert.equal(fs.existsSync(f.workspace.dir), false);
    assert.ok(fs.existsSync(path.join(f.other.dir, 'projects.json')));
  } finally {
    release.resolve();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('queued RAG indexing checks account revocation before opening a tenant directory', async () => {
  const f = fixture();
  const rag = require('./rag.cjs');
  let checked = 0;
  try {
    rag.init({ dataDir: f.root, inferenceUrl: 'http://unused.invalid',
      userDataDirFn: (id) => f.workspaces.userDir(id),
      userActive: (id) => { checked += 1; return !f.workspaces.isRemoved(id); } });
    f.workspaces.remove(DELETED_ID);
    const result = await rag.indexProjectFile('p1', 'synthetic.txt', 'synthetic content', DELETED_ID);
    assert.equal(result.superseded, true);
    assert.ok(checked > 0);
    assert.equal(fs.existsSync(f.workspace.dir), false);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
