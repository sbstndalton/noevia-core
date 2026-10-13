'use strict';
// #1454: an upload never replaces an existing project source unless the request says `replace: true`.
// A stateful WebDAV stand-in (PUT honours If-None-Match) stands behind the real storage client.
// Synthetic fixtures only.
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

const FOLDER = 'noevia projects/Alpha';
async function dav(t, initial = {}) {
  const files = new Map(Object.entries(initial));
  const folders = new Set();
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/remote\.php\/dav\/files\/alice\/?/, '').replace(/\/+$/, '');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.method === 'MKCOL') { const had = folders.has(rel); folders.add(rel); res.writeHead(had ? 405 : 201); return res.end(); }
      if (req.method === 'PUT') {
        if (req.headers['if-none-match'] === '*' && files.has(rel)) { res.writeHead(412); return res.end(); }
        files.set(rel, Buffer.concat(chunks).toString()); res.writeHead(files.has(rel) ? 201 : 204); return res.end();
      }
      res.writeHead(404); res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return { files, baseUrl: `http://127.0.0.1:${server.address().port}/remote.php/dav/files/alice` };
}

function fixture(t, { baseUrl, project, remote = true }) {
  const sent = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-1454-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const projects = [project];
  const store = {
    getProject: (id) => projects.find((p) => p.id === id) || null, saveProjects() {}, pruneDocuments() {},
    withSourceLock: (_p, op) => op(), indexSource() {}, ownsFile: () => false, loadChats: () => [], saveChats() {}, deleteChat: () => false,
    ensureProjectFolder: async () => project.projectFolder,
  };
  const routes = createProjectRoutes({
    json: (res, status, body) => { sent.push({ status, body }); },
    readBody: async (req) => { let s = ''; for await (const c of req) s += c; return s; },
    readJson: require('../http.cjs').readJson,
    requestScope: new AsyncLocalStorage(), dispatch: async () => {},
    currentWorkspace: () => ({ dir, userId: 'u1', assertActive() {}, ragDir: () => path.join(dir, 'rag'), assetDir: () => path.join(dir, 'assets') }),
    authService: { diaryEnabled: () => true, getStorage: () => remote ? { kind: 'webdav', baseUrl, username: 'alice', secret: 'synthetic-secret' } : { kind: 'local' } },
    storageClient, documents: { isDocument: (n) => /\.pdf$/i.test(n) }, documentSources: {}, rag: { deleteProjectFile() {}, indexProjectFile: async () => ({}) },
    fs, path, reasoningEffort: {}, projectAppearance: () => ({}),
    diaryExtras: { PROJECT_ID: 'diary-extras', chatProjectId: (id) => id, newProject: () => ({}) },
    PROJECTS: projects, DEFAULT_TOOLBOXES: ['core'], sanitizeToolboxes: (b) => b, getProvider: () => ({}), ensureRolesLoaded() {},
    servedCatalogue: async () => null, DEFAULT_PROVIDER_ID: 'default', store,
  });
  const upload = async (body, route = 'upload') => {
    const url = `/api/projects/${project.id}/${route}`;
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    Object.assign(req, { method: 'POST', url, headers: {}, socket: {} });
    await routes(req, {}, { path: url, authn: { user: { id: 'u1', role: 'member' } }, url: new URL(`http://localhost${url}`) });
    return sent.at(-1);
  };
  return { upload, sent, project };
}
const note = (text, extra = {}) => ({ name: 'report.md', organized: true, dataBase64: Buffer.from(text).toString('base64'), ...extra });
const existingSource = () => ({ name: `${FOLDER}/Text/report.md`, content: 'old', source: FOLDER, attachment: { id: 'a'.repeat(64), bytes: 3, group: 'Text', state: 'ready' } });
const proj = (files = []) => ({ id: 'p1', name: 'Alpha', projectFolder: FOLDER, sourceFolders: [FOLDER], files, assets: [] });

test('#1454: an organized upload over an existing source is refused, and nothing in storage or the project changes', async (t) => {
  const d = await dav(t, { [`${FOLDER}/Text/report.md`]: 'old' });
  const f = fixture(t, { baseUrl: d.baseUrl, project: proj([existingSource()]) });
  const r = await f.upload(note('NEW'));
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'sourceExists');
  assert.equal(r.body.name, 'report.md');
  assert.match(r.body.error, /already exists.*not replaced/);
  assert.equal(d.files.get(`${FOLDER}/Text/report.md`), 'old');
  assert.equal(f.project.files.length, 1);
  assert.equal(f.project.files[0].content, 'old');
});

test('#1454: replace:true is the one way to overwrite, and it does', async (t) => {
  const d = await dav(t, { [`${FOLDER}/Text/report.md`]: 'old' });
  const f = fixture(t, { baseUrl: d.baseUrl, project: proj([existingSource()]) });
  const r = await f.upload(note('NEW', { replace: true }));
  assert.equal(r.status, 200);
  assert.equal(d.files.get(`${FOLDER}/Text/report.md`), 'NEW');
  assert.equal(f.project.files.length, 1);
  assert.equal(f.project.files[0].content, 'NEW');
});

test('#1454: a file already in storage but not yet synced into the project is not overwritten either', async (t) => {
  const d = await dav(t, { [`${FOLDER}/Text/report.md`]: 'someone else wrote this' });
  const f = fixture(t, { baseUrl: d.baseUrl, project: proj([]) });
  const r = await f.upload(note('NEW'));
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'sourceExists');
  assert.equal(d.files.get(`${FOLDER}/Text/report.md`), 'someone else wrote this');
  assert.equal(f.project.files.length, 0);
});

test('#1454: a free name saves normally, so a numbered copy is stored beside the original', async (t) => {
  const d = await dav(t, { [`${FOLDER}/Text/report.md`]: 'old' });
  const f = fixture(t, { baseUrl: d.baseUrl, project: proj([existingSource()]) });
  const r = await f.upload({ ...note('COPY'), name: 'report (2).md' });
  assert.equal(r.status, 200);
  assert.equal(d.files.get(`${FOLDER}/Text/report.md`), 'old');
  assert.equal(d.files.get(`${FOLDER}/Text/report (2).md`), 'COPY');
  assert.deepEqual(f.project.files.map((x) => x.name).sort(), [`${FOLDER}/Text/report (2).md`, `${FOLDER}/Text/report.md`]);
});

test('#1454: the plain (non-organized) storage upload is create-only unless replace is sent', async (t) => {
  const d = await dav(t, { [`${FOLDER}/report.md`]: 'old' });
  const f = fixture(t, { baseUrl: d.baseUrl, project: proj([]) });
  const refused = await f.upload(note('NEW', { organized: false, name: 'report.md' }));
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'sourceExists');
  assert.equal(d.files.get(`${FOLDER}/report.md`), 'old');
  const replaced = await f.upload(note('NEW', { organized: false, replace: true }));
  assert.equal(replaced.status, 200);
  assert.equal(d.files.get(`${FOLDER}/report.md`), 'NEW');
});

test('#1454: without storage a same-name upload is refused too, and replace:true replaces', async (t) => {
  const f = fixture(t, { baseUrl: 'http://127.0.0.1:1/unused', remote: false, project: { id: 'p1', name: 'Alpha', files: [{ name: 'report.md', content: 'old' }], assets: [] } });
  const refused = await f.upload(note('NEW', { organized: false }));
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'sourceExists');
  assert.equal(f.project.files[0].content, 'old');
  const replaced = await f.upload(note('NEW', { organized: false, replace: true }));
  assert.equal(replaced.status, 200);
  assert.equal(f.project.files.length, 1);
  assert.equal(f.project.files[0].content, 'NEW');
});

test('#1454: the document route refuses a PDF whose name an upload already has, and keeps the old one', async (t) => {
  const old = { name: 'paper.pdf', content: 'old text', document: { state: 'ready', pages: 1 } };
  const f = fixture(t, { baseUrl: 'http://127.0.0.1:1/unused', remote: false, project: { id: 'p1', name: 'Alpha', files: [old], assets: [] } });
  const r = await f.upload({ name: 'paper.pdf', dataBase64: Buffer.from('%PDF-1.4 synthetic').toString('base64') }, 'documents');
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'sourceExists');
  assert.equal(f.project.files[0], old);
});
