'use strict';
// #1664: a failure AFTER a create-only storage write (project removed mid-upload, the project save
// throwing) must remove the just-written file, conditional on the ETag the PUT returned, so a retry
// does not meet a 409 and save a "(2)" copy. A replace never deletes. Synthetic fixtures only.
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
// WebDAV stand-in: PUT honours If-None-Match and answers an ETag; DELETE honours If-Match.
async function dav(t, initial = {}) {
  const files = new Map(Object.entries(initial).map(([k, v]) => [k, { body: v, etag: `"seed-${k.length}"` }]));
  const deletes = [];
  let n = 0;
  const hooks = { afterPut() {}, deleteStatus: null };
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/remote\.php\/dav\/files\/alice\/?/, '').replace(/\/+$/, '');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.method === 'MKCOL') { res.writeHead(405); return res.end(); }
      if (req.method === 'PUT') {
        if (req.headers['if-none-match'] === '*' && files.has(rel)) { res.writeHead(412); return res.end(); }
        const etag = `"v${++n}"`;
        const had = files.has(rel);
        files.set(rel, { body: Buffer.concat(chunks).toString(), etag });
        hooks.afterPut(rel);
        res.writeHead(had ? 204 : 201, { ETag: etag }); return res.end();
      }
      if (req.method === 'DELETE') {
        deletes.push({ path: rel, ifMatch: req.headers['if-match'] });
        if (hooks.deleteStatus) { res.writeHead(hooks.deleteStatus); return res.end(); }
        const f = files.get(rel);
        if (!f) { res.writeHead(404); return res.end(); }
        if (req.headers['if-match'] !== f.etag) { res.writeHead(412); return res.end(); }
        files.delete(rel); res.writeHead(204); return res.end();
      }
      res.writeHead(404); res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return { files, deletes, hooks, baseUrl: `http://127.0.0.1:${server.address().port}/remote.php/dav/files/alice` };
}

function fixture(t, { baseUrl, project }) {
  const documentSources = { ingest: async (_w, _id, name) => ({ name, content: 'text', document: { state: 'ready' } }) };
  const sent = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-1664-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const projects = [project];
  const ctl = { saveFails: false };
  const store = {
    getProject: (id) => projects.find((p) => p.id === id) || null,
    saveProjects() { if (ctl.saveFails) throw new Error('synthetic save failure'); },
    pruneDocuments() {},
    withSourceLock: (_p, op) => op(), indexSource() {}, ownsFile: () => false, loadChats: () => [], saveChats() {}, deleteChat: () => false,
    ensureProjectFolder: async () => project.projectFolder,
  };
  const routes = createProjectRoutes({
    json: (res, status, body) => { sent.push({ status, body }); },
    readBody: async (req) => { let s = ''; for await (const c of req) s += c; return s; },
    readJson: require('../http.cjs').readJson,
    requestScope: new AsyncLocalStorage(), dispatch: async () => {},
    currentWorkspace: () => ({ dir, userId: 'u1', assertActive() {}, ragDir: () => path.join(dir, 'rag'), assetDir: () => path.join(dir, 'assets') }),
    authService: { diaryEnabled: () => true, getStorage: () => ({ kind: 'webdav', baseUrl, username: 'alice', secret: 'synthetic-secret' }) },
    storageClient, documents: { isDocument: (n) => /\.pdf$/i.test(n) }, documentSources, rag: { deleteProjectFile() {}, indexProjectFile: async () => ({}) },
    fs, path, reasoningEffort: {}, projectAppearance: () => ({}),
    diaryExtras: { PROJECT_ID: 'diary-extras', chatProjectId: (id) => id, newProject: () => ({}) },
    PROJECTS: projects, DEFAULT_TOOLBOXES: ['core'], sanitizeToolboxes: (b) => b, getProvider: () => ({}), ensureRolesLoaded() {},
    servedCatalogue: async () => null, DEFAULT_PROVIDER_ID: 'default', store,
  });
  const upload = async (body) => {
    const url = `/api/projects/${project.id}/upload`;
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    Object.assign(req, { method: 'POST', url, headers: {}, socket: {} });
    await routes(req, {}, { path: url, authn: { user: { id: 'u1', role: 'member' } }, url: new URL(`http://localhost${url}`) });
    return sent.at(-1);
  };
  return { upload, sent, project, projects, ctl };
}
const note = (text, extra = {}) => ({ name: 'report.md', organized: true, dataBase64: Buffer.from(text).toString('base64'), ...extra });
const pdf = (extra = {}) => ({ name: 'scan.pdf', organized: false, dataBase64: Buffer.from('%PDF-1.4 synthetic').toString('base64'), ...extra });
const proj = (files = []) => ({ id: 'p1', name: 'Alpha', projectFolder: FOLDER, sourceFolders: [FOLDER], files, assets: [] });
const recorded = (name) => ({ name, content: 'old', source: FOLDER, attachment: { id: 'a'.repeat(64), bytes: 3, group: 'Text', state: 'ready' } });
const quiet = (t) => { const warn = console.warn; console.warn = () => {}; t.after(() => { console.warn = warn; }); };

test('#1664: organized upload whose project save throws removes the written file with If-Match, and the save error surfaces', async (t) => {
  quiet(t);
  const d = await dav(t);
  const f = fixture(t, { baseUrl: d.baseUrl, project: proj() });
  f.ctl.saveFails = true;
  await assert.rejects(f.upload(note('NEW')), /synthetic save failure/);
  assert.deepEqual(d.deletes, [{ path: `${FOLDER}/Text/report.md`, ifMatch: '"v1"' }]);
  assert.equal(d.files.has(`${FOLDER}/Text/report.md`), false, 'no orphan left in storage');
  f.ctl.saveFails = false;
  const retry = await f.upload(note('NEW'));
  assert.equal(retry.status, 200, 'the retry is not a 409');
  assert.equal(d.files.get(`${FOLDER}/Text/report.md`).body, 'NEW');
});

test('#1664: organized upload whose project is removed mid-upload removes the written file and still answers 409', async (t) => {
  quiet(t);
  const d = await dav(t);
  const f = fixture(t, { baseUrl: d.baseUrl, project: proj() });
  d.hooks.afterPut = () => { f.projects.length = 0; };
  const r = await f.upload(note('NEW'));
  assert.equal(r.status, 409);
  assert.match(r.body.error, /Project removed during upload/);
  assert.deepEqual(d.deletes, [{ path: `${FOLDER}/Text/report.md`, ifMatch: '"v1"' }]);
  assert.equal(d.files.has(`${FOLDER}/Text/report.md`), false);
});

test('#1664: a file edited in storage after the write is kept (412), and the original error still surfaces', async (t) => {
  quiet(t);
  const d = await dav(t);
  const f = fixture(t, { baseUrl: d.baseUrl, project: proj() });
  f.ctl.saveFails = true;
  d.hooks.afterPut = (rel) => { d.files.set(rel, { body: 'someone edited', etag: '"other"' }); };
  await assert.rejects(f.upload(note('NEW')), /synthetic save failure/);
  assert.deepEqual(d.deletes, [{ path: `${FOLDER}/Text/report.md`, ifMatch: '"v1"' }]);
  assert.equal(d.files.get(`${FOLDER}/Text/report.md`).body, 'someone edited');
});

test('#1664: a failing cleanup DELETE does not hide the original error', async (t) => {
  quiet(t);
  const d = await dav(t);
  const f = fixture(t, { baseUrl: d.baseUrl, project: proj() });
  f.ctl.saveFails = true;
  d.hooks.deleteStatus = 500;
  await assert.rejects(f.upload(note('NEW')), /synthetic save failure/);
  assert.equal(d.deletes.length, 1);
});

test('#1664: an organized replace:true never deletes, even when the save throws', async (t) => {
  quiet(t);
  const d = await dav(t, { [`${FOLDER}/Text/report.md`]: 'old' });
  const f = fixture(t, { baseUrl: d.baseUrl, project: proj([recorded(`${FOLDER}/Text/report.md`)]) });
  f.ctl.saveFails = true;
  // The same failure on a create-only upload of a new name does clean up ...
  await assert.rejects(f.upload(note('OTHER', { name: 'other.md' })), /synthetic save failure/);
  assert.deepEqual(d.deletes, [{ path: `${FOLDER}/Text/other.md`, ifMatch: '"v1"' }]);
  // ... but a replace of a recorded source never deletes.
  await assert.rejects(f.upload(note('NEW', { replace: true })), /synthetic save failure/);
  assert.equal(d.deletes.length, 1, 'the replace made no DELETE');
  assert.equal(d.files.get(`${FOLDER}/Text/report.md`).body, 'NEW');
});

test('#1664: plain storage upload of a PDF whose save throws removes the written file with If-Match', async (t) => {
  quiet(t);
  const d = await dav(t);
  const f = fixture(t, { baseUrl: d.baseUrl, project: proj() });
  // The route saves once before the write (source folders); fail only the save that records the file.
  d.hooks.afterPut = () => { f.ctl.saveFails = true; };
  await assert.rejects(f.upload(pdf()), /synthetic save failure/);
  assert.deepEqual(d.deletes, [{ path: `${FOLDER}/scan.pdf`, ifMatch: '"v1"' }]);
  assert.equal(d.files.has(`${FOLDER}/scan.pdf`), false);
});

test('#1664: plain storage upload of a PDF removed mid-upload removes the file; replace:true never deletes', async (t) => {
  quiet(t);
  const d = await dav(t);
  const f = fixture(t, { baseUrl: d.baseUrl, project: proj() });
  d.hooks.afterPut = () => { f.projects.length = 0; };
  const r = await f.upload(pdf());
  assert.equal(r.status, 409);
  assert.deepEqual(d.deletes, [{ path: `${FOLDER}/scan.pdf`, ifMatch: '"v1"' }]);
  assert.equal(d.files.has(`${FOLDER}/scan.pdf`), false);
  f.projects.push(f.project);
  const replaced = await f.upload(pdf({ replace: true }));
  assert.equal(replaced.status, 409);
  assert.equal(d.deletes.length, 1, 'the replace path made no DELETE');
  assert.equal(d.files.get(`${FOLDER}/scan.pdf`).body, '%PDF-1.4 synthetic');
});
