'use strict';
// #849: a storage login the server rejected (401/403) is reported as that on every upload path,
// not as "could not create the storage folder; retry". A WebDAV stand-in answers 401; the real
// storage client talks to it. Synthetic fixtures only.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { AsyncLocalStorage } = require('node:async_hooks');
const { createProjectRoutes } = require('./projects.cjs');
const storageClient = require('../storage-client.cjs');

async function dav(t, status) {
  const server = http.createServer((req, res) => { req.resume(); res.writeHead(status); res.end(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}/remote.php/dav/files/alice`;
}

function fixture(t, { baseUrl, project, detailed }) {
  const sent = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-849-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const projects = [project];
  const store = {
    getProject: (id) => projects.find((p) => p.id === id) || null, saveProjects() {}, pruneDocuments() {},
    withSourceLock: (_p, op) => op(), indexSource() {}, ownsFile: () => false, loadChats: () => [], saveChats() {}, deleteChat: () => false,
    ensureProjectFolder: async () => null,
    ...(detailed ? { ensureProjectFolderDetailed: detailed } : {}),
  };
  const routes = createProjectRoutes({
    json: (res, status, body) => { sent.push({ status, body }); },
    readBody: async (req) => { let s = ''; for await (const c of req) s += c; return s; },
    readJson: require('../http.cjs').readJson,
    requestScope: new AsyncLocalStorage(), dispatch: async () => {},
    currentWorkspace: () => ({ dir, userId: 'u1', assertActive() {}, ragDir: () => path.join(dir, 'rag'), assetDir: () => path.join(dir, 'assets') }),
    authService: { diaryEnabled: () => true, getStorage: () => ({ kind: 'webdav', baseUrl, username: 'alice', secret: 'synthetic-secret', corpusRoot: 'Diary' }) },
    storageClient, documents: { isDocument: () => false }, documentSources: {}, rag: { deleteProjectFile() {}, indexProjectFile: async () => ({}) },
    fs, path, reasoningEffort: {}, projectAppearance: () => ({}),
    diaryExtras: { PROJECT_ID: 'diary-extras', chatProjectId: (id) => id, newProject: () => ({}) },
    PROJECTS: projects, DEFAULT_TOOLBOXES: ['core'], sanitizeToolboxes: (b) => b, getProvider: () => ({}), ensureRolesLoaded() {},
    servedCatalogue: async () => null, DEFAULT_PROVIDER_ID: 'default', store,
  });
  const upload = (body) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    Object.assign(req, { method: 'POST', url: `/api/projects/${project.id}/upload`, headers: {}, socket: {} });
    return routes(req, {}, { path: `/api/projects/${project.id}/upload`, authn: { user: { id: 'u1', role: 'member' } }, url: new URL(`http://localhost/api/projects/${project.id}/upload`) });
  };
  return { upload, sent };
}

const NOTE = { name: 'note.txt', dataBase64: Buffer.from('synthetic note').toString('base64') };
const LOGIN = /^Storage login rejected\. Check your storage credentials in Settings/;

test('#849: first upload with a rejected login says so (organized path), from the folder step', async (t) => {
  const f = fixture(t, { baseUrl: 'http://127.0.0.1:1/unused', project: { id: 'p1', name: 'P', files: [], assets: [] },
    detailed: async () => ({ folder: null, loginRejected: true }) });
  await f.upload({ ...NOTE, organized: true });
  assert.equal(f.sent.at(-1).status, 502, 'never 401: the client reads that as an expired noevia session');
  assert.match(f.sent.at(-1).body.error, LOGIN);
  assert.equal(f.sent.at(-1).body.code, 'storageLoginRejected');
});

test('#849: first upload with a rejected login says so (plain path), from the folder step', async (t) => {
  const f = fixture(t, { baseUrl: 'http://127.0.0.1:1/unused', project: { id: 'p1', name: 'P', files: [], assets: [] },
    detailed: async () => ({ folder: null, loginRejected: true }) });
  await f.upload(NOTE);
  assert.equal(f.sent.at(-1).status, 502);
  assert.equal(f.sent.at(-1).body.code, 'storageLoginRejected');
});

test('#849: any other folder failure keeps its generic, retryable wording', async (t) => {
  const f = fixture(t, { baseUrl: 'http://127.0.0.1:1/unused', project: { id: 'p1', name: 'P', files: [], assets: [] },
    detailed: async () => ({ folder: null, loginRejected: false }) });
  await f.upload({ ...NOTE, organized: true });
  assert.equal(f.sent.at(-1).body.error, 'Could not create the storage folder; retry.');
  assert.equal(f.sent.at(-1).body.code, undefined);
  await f.upload(NOTE);
  assert.match(f.sent.at(-1).body.error, /^Could not create the project storage folder/);
  assert.equal(f.sent.at(-1).body.code, undefined);
});

test('#849: a folder that exists but whose write is refused (401, 403) is also a rejected login', async (t) => {
  for (const status of [401, 403]) {
    const base = await dav(t, status);
    const project = () => ({ id: 'p1', name: 'P', projectFolder: 'noevia projects/P', files: [], assets: [] });
    const organized = fixture(t, { baseUrl: base, project: project() });
    await organized.upload({ ...NOTE, organized: true });
    assert.equal(organized.sent.at(-1).status, 502, `organized ${status}`);
    assert.equal(organized.sent.at(-1).body.code, 'storageLoginRejected');
    const plain = fixture(t, { baseUrl: base, project: project() });
    await plain.upload(NOTE);
    assert.equal(plain.sent.at(-1).status, 502, `plain ${status}`);
    assert.equal(plain.sent.at(-1).body.code, 'storageLoginRejected');
  }
});

test('#849: refusedLogin recognises only a 401/403 answer from storage', () => {
  const { refusedLogin } = storageClient;
  assert.equal(refusedLogin(Object.assign(new Error('x'), { upstream: 401 })), true);
  assert.equal(refusedLogin(Object.assign(new Error('x'), { upstream: 403 })), true);
  assert.equal(refusedLogin(new Error('storage returned 401')), true);
  assert.equal(refusedLogin(new Error('storage returned 403')), true);
  assert.equal(refusedLogin(Object.assign(new Error('x'), { upstream: 404 })), false);
  assert.equal(refusedLogin(new Error('storage returned 404')), false);
  assert.equal(refusedLogin(new Error('could not write "a" (500)')), false);
  assert.equal(refusedLogin(new Error('fetch failed')), false);
  assert.equal(refusedLogin(null), false);
});
