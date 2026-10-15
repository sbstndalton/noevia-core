'use strict';
// #1805: import a whole folder, every subfolder included, through the real project routes and the
// real storage client against a stateful WebDAV stand-in (PROPFIND Depth 1, GET, PUT with
// If-None-Match, MKCOL that needs its parent). Also: attached storage folders are read recursively.
// Synthetic fixtures only.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { AsyncLocalStorage } = require('node:async_hooks');
const { createProjectRoutes } = require('./projects.cjs');
const storageClient = require('../storage-client.cjs');

const FOLDER = 'noevia projects/Alpha';
const sha = (c) => crypto.createHash('sha256').update(c).digest('hex');

async function dav(t, initial = {}) {
  const files = new Map(Object.entries(initial).map(([k, v]) => [k, Buffer.from(v)]));
  const dirs = new Set(['']);
  const puts = [], failing = new Set();
  const parentOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  for (const k of files.keys()) for (let d = parentOf(k); d; d = parentOf(d)) dirs.add(d);
  const children = (dir) => {
    const out = new Map();
    for (const p of [...files.keys(), ...dirs]) if (p && parentOf(p) === dir) out.set(p, dirs.has(p));
    return out;
  };
  const href = (p, dir) => '/dav/' + p.split('/').map(encodeURIComponent).join('/') + (dir ? '/' : '');
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/dav\/?/, '').replace(/\/+$/, '');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.method === 'PROPFIND') {
        if (failing.has(rel)) { res.writeHead(500); return res.end(); }
        if (!dirs.has(rel)) { res.writeHead(404); return res.end(); }
        const rows = [`<d:response><d:href>${href(rel, true)}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>`];
        for (const [p, isDir] of children(rel)) {
          rows.push(`<d:response><d:href>${href(p, isDir)}</d:href><d:propstat><d:prop><d:resourcetype>${isDir ? '<d:collection/>' : ''}</d:resourcetype>${isDir ? '' : `<d:getcontentlength>${files.get(p).length}</d:getcontentlength>`}</d:prop></d:propstat></d:response>`);
        }
        res.writeHead(207, { 'Content-Type': 'application/xml' });
        return res.end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${rows.join('')}</d:multistatus>`);
      }
      if (req.method === 'GET') { if (!files.has(rel)) { res.writeHead(404); return res.end(); } res.writeHead(200); return res.end(files.get(rel)); }
      if (req.method === 'MKCOL') {
        if (dirs.has(rel)) { res.writeHead(405); return res.end(); }
        if (!dirs.has(parentOf(rel))) { res.writeHead(409); return res.end(); }
        dirs.add(rel); res.writeHead(201); return res.end();
      }
      if (req.method === 'PUT') {
        if (!dirs.has(parentOf(rel))) { res.writeHead(409); return res.end(); }
        if (req.headers['if-none-match'] === '*' && files.has(rel)) { res.writeHead(412); return res.end(); }
        const existed = files.has(rel);
        files.set(rel, Buffer.concat(chunks)); puts.push(rel); res.writeHead(existed ? 204 : 201, { ETag: `"e${puts.length}"` }); return res.end();
      }
      res.writeHead(405); res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return { files, dirs, puts, failing, baseUrl: `http://127.0.0.1:${server.address().port}/dav` };
}

function fixture(t, { baseUrl, project, remote = true }) {
  const sent = [], indexed = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-1805-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const projects = [project];
  const store = {
    getProject: (id) => projects.find((p) => p.id === id) || null, saveProjects() {}, pruneDocuments() {},
    withSourceLock: (_p, op) => op(), indexSource: (_p, file) => indexed.push(file.name), ownsFile: () => false, loadChats: () => [], saveChats() {}, deleteChat: () => false,
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
  const post = async (route, body, user = 'u1', projectId = project.id) => {
    const url = `/api/projects/${projectId}/${route}`;
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    Object.assign(req, { method: 'POST', url, headers: {}, socket: {} });
    await routes(req, {}, { path: url, authn: { user: { id: user, role: 'member' } }, url: new URL(`http://localhost${url}`) });
    return sent.at(-1);
  };
  const planOf = (folder, user) => post('folder-import/plan', { entries: Object.entries(folder).map(([p, c]) => ({ path: p, size: Buffer.byteLength(c), sha256: sha(c) })) }, user);
  const send = (importId, rel, content, user) => post('upload', { name: rel.split('/').pop(), relativePath: rel, importId, organized: true, dataBase64: Buffer.from(content).toString('base64') }, user);
  /** Plan and upload a whole synthetic folder the way the client does. */
  const importFolder = async (folder) => {
    const plan = await planOf(folder);
    assert.equal(plan.status, 200, JSON.stringify(plan.body));
    const results = [];
    for (const a of plan.body.accepted) results.push(await send(plan.body.importId, a.path, folder[a.path]));
    return { plan: plan.body, results };
  };
  return { post, planOf, send, importFolder, sent, indexed, project };
}
const proj = (files = []) => ({ id: 'p1', name: 'Alpha', projectFolder: FOLDER, sourceFolders: [FOLDER], files, assets: [] });

// Three levels, the same file name in two subfolders, and a .git and node_modules that must not travel.
const SYNTHETIC = {
  'readme.md': '# Synthetic top\n',
  'docs/readme.md': '# Synthetic docs readme\n',
  'docs/api/auth.md': '# Synthetic auth\n',
  'notes/readme.md': '# Synthetic notes readme\n',
  'notes/2026/q4/plan.txt': 'synthetic plan\n',
  '.git/config': '[core]\n',
  '.git/HEAD': 'ref: refs/heads/main\n',
  'node_modules/left-pad/index.js': 'module.exports = 1;\n',
  'node_modules/left-pad/readme.md': '# not ours\n',
  '.DS_Store': 'synthetic',
  'tool.exe': 'MZsynthetic',
};

test('#1805: a nested folder is stored under its relative paths; same-named files in two subfolders do not collide, and each is indexed', async (t) => {
  const d = await dav(t);
  d.dirs.add('noevia projects'); d.dirs.add(FOLDER);
  const f = fixture(t, { baseUrl: d.baseUrl, project: proj() });
  const { plan, results } = await f.importFolder(SYNTHETIC);
  assert.deepEqual(plan.accepted.map((a) => a.path).sort(), ['docs/api/auth.md', 'docs/readme.md', 'notes/2026/q4/plan.txt', 'notes/readme.md', 'readme.md']);
  for (const r of results) assert.equal(r.status, 200, JSON.stringify(r.body));
  const stored = [...d.files.keys()].sort();
  assert.deepEqual(stored, [
    `${FOLDER}/Text/docs/api/auth.md`, `${FOLDER}/Text/docs/readme.md`, `${FOLDER}/Text/notes/2026/q4/plan.txt`, `${FOLDER}/Text/notes/readme.md`, `${FOLDER}/Text/readme.md`,
  ]);
  assert.equal(String(d.files.get(`${FOLDER}/Text/docs/readme.md`)), SYNTHETIC['docs/readme.md']);
  assert.equal(String(d.files.get(`${FOLDER}/Text/notes/readme.md`)), SYNTHETIC['notes/readme.md']);
  assert.deepEqual(f.project.files.map((x) => x.name).sort(), stored, 'every file is a project source under its own path');
  assert.deepEqual([...f.indexed].sort(), stored, 'and every one went to the normal indexing pipeline');
  assert.equal(results.find((r) => r.body.path === `${FOLDER}/Text/docs/api/auth.md`).body.name, 'auth.md');
});

test('#1805: without storage a folder import keeps the relative paths as the source names', async (t) => {
  const f = fixture(t, { baseUrl: 'http://127.0.0.1:1/unused', remote: false, project: { id: 'p1', name: 'Alpha', files: [], assets: [] } });
  await f.importFolder({ 'a/readme.md': 'A', 'b/readme.md': 'B' });
  assert.deepEqual(f.project.files.map((x) => [x.name, x.content]).sort(), [['a/readme.md', 'A'], ['b/readme.md', 'B']]);
});

test('#1805: path traversal and absolute paths are refused by the upload route and nothing is written', async (t) => {
  const d = await dav(t);
  d.dirs.add('noevia projects'); d.dirs.add(FOLDER);
  const f = fixture(t, { baseUrl: d.baseUrl, project: proj() });
  const plan = (await f.planOf({ 'ok.md': 'fine' })).body;
  for (const bad of ['../escape.md', 'docs/../../escape.md', '/etc/escape.md', 'C:\\escape.md', '..\\..\\escape.md', 'docs/./a.md']) {
    const r = await f.send(plan.importId, bad, 'x');
    assert.equal(r.status, 400, `${bad}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.code, 'invalidPath', bad);
  }
  const listed = (await f.planOf({ '../escape.md': 'x', 'a/../../b.md': 'y' })).body;
  assert.deepEqual(listed.accepted, []);
  assert.deepEqual(listed.skipped.map((s) => s.code), ['invalidPath', 'invalidPath']);
  assert.equal(d.files.size, 0);
  assert.deepEqual(f.project.files, []);
});

test('#1805: skipped names and types are refused even when sent directly, and the plan says why', async (t) => {
  const d = await dav(t);
  d.dirs.add('noevia projects'); d.dirs.add(FOLDER);
  const f = fixture(t, { baseUrl: d.baseUrl, project: proj() });
  const plan = (await f.planOf(SYNTHETIC)).body;
  const why = Object.fromEntries(plan.skipped.map((s) => [s.path, s.code]));
  assert.deepEqual(why, {
    '.DS_Store': 'system', '.git/HEAD': 'system', '.git/config': 'system',
    'node_modules/left-pad/index.js': 'system', 'node_modules/left-pad/readme.md': 'system', 'tool.exe': 'unsupported',
  });
  for (const rel of ['node_modules/left-pad/readme.md', '.git/config', 'tool.exe']) {
    const r = await f.send(plan.importId, rel, 'x');
    assert.equal(r.status, 400, rel);
  }
  assert.equal(d.files.size, 0);
});

test('#1805: the caps hold on the server: a path the plan did not accept is refused, as is another person\'s or an unknown import', async (t) => {
  const d = await dav(t);
  d.dirs.add('noevia projects'); d.dirs.add(FOLDER);
  const f = fixture(t, { baseUrl: d.baseUrl, project: proj() });
  process.env.FOLDER_IMPORT_MAX_FILES = '2';
  t.after(() => { delete process.env.FOLDER_IMPORT_MAX_FILES; });
  const plan = (await f.planOf({ 'a.md': 'A', 'b.md': 'B', 'c.md': 'C' })).body;
  assert.deepEqual(plan.limits.maxFiles, 2);
  assert.deepEqual(plan.accepted.map((a) => a.path), ['a.md', 'b.md']);
  assert.deepEqual(plan.skipped.map((s) => [s.path, s.code]), [['c.md', 'fileLimit']]);
  const over = await f.send(plan.importId, 'c.md', 'C');
  assert.equal(over.status, 409);
  assert.equal(over.body.code, 'importNotPlanned');
  assert.equal((await f.send(plan.importId, 'a.md', 'A', 'u2')).body.code, 'importNotPlanned', 'another person cannot use this import');
  assert.equal((await f.send('0'.repeat(32), 'a.md', 'A')).body.code, 'importNotPlanned');
  assert.equal((await f.send(plan.importId, 'a.md', 'A')).status, 200);
  assert.equal((await f.send(plan.importId, 'a.md', 'A')).body.code, 'importNotPlanned', 'each accepted path is used once');
  assert.deepEqual([...d.files.keys()], [`${FOLDER}/Text/a.md`]);
  process.env.FOLDER_IMPORT_MAX_BYTES = '3';
  t.after(() => { delete process.env.FOLDER_IMPORT_MAX_BYTES; });
  const bytes = (await f.planOf({ 'x.md': 'XX', 'y.md': 'YY' })).body;
  assert.deepEqual(bytes.skipped.map((s) => [s.path, s.code]), [['y.md', 'sizeLimit']]);
});

test('#1805: re-importing a folder leaves unchanged files alone and updates changed ones in place, never a duplicate', async (t) => {
  const d = await dav(t);
  d.dirs.add('noevia projects'); d.dirs.add(FOLDER);
  const f = fixture(t, { baseUrl: d.baseUrl, project: proj() });
  const first = { 'docs/readme.md': 'v1 docs', 'notes/readme.md': 'v1 notes' };
  await f.importFolder(first);
  const putsAfterFirst = d.puts.length;
  const second = { 'docs/readme.md': 'v1 docs', 'notes/readme.md': 'v2 notes, edited' };
  const { plan, results } = await f.importFolder(second);
  assert.deepEqual(plan.unchanged, [{ path: 'docs/readme.md' }]);
  assert.deepEqual(plan.accepted.map((a) => [a.path, a.change]), [['notes/readme.md', 'changed']]);
  assert.equal(results[0].status, 200);
  assert.deepEqual(d.puts.slice(putsAfterFirst), [`${FOLDER}/Text/notes/readme.md`], 'only the changed file is written');
  assert.equal(String(d.files.get(`${FOLDER}/Text/notes/readme.md`)), 'v2 notes, edited');
  assert.deepEqual(f.project.files.map((x) => x.name).sort(), [`${FOLDER}/Text/docs/readme.md`, `${FOLDER}/Text/notes/readme.md`], 'no "(2)" copies');
  assert.equal(f.project.files.find((x) => x.name.endsWith('notes/readme.md')).content, 'v2 notes, edited');
  // An upload that races a stale plan with identical bytes is answered as unchanged without a write.
  const stale = (await f.planOf({ 'docs/readme.md': 'v1 docs, other' })).body;
  const same = await f.send(stale.importId, 'docs/readme.md', 'v1 docs');
  assert.equal(same.status, 200);
  assert.equal(same.body.unchanged, true);
  assert.equal(d.puts.length, putsAfterFirst + 1);
});

test('#1805: a folder plan is refused for the Diary context project', async (t) => {
  const f = fixture(t, { baseUrl: 'http://127.0.0.1:1/unused', remote: false, project: { id: 'diary-extras', name: 'Extras', files: [], assets: [] } });
  const r = await f.post('folder-import/plan', { entries: [{ path: 'a.md', size: 1 }] });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /project only/);
});

test('#1805: refreshing an attached storage folder reads every subfolder, skips system folders, and does not sync a nested attached folder twice', async (t) => {
  const d = await dav(t, {
    'Shared/Team/top.md': 'top',
    'Shared/Team/docs/readme.md': 'docs readme',
    'Shared/Team/docs/api/auth.md': 'auth',
    'Shared/Team/notes/readme.md': 'notes readme',
    'Shared/Team/notes/2026/q4/plan.txt': 'plan',
    'Shared/Team/.git/config.md': 'git',
    'Shared/Team/node_modules/pkg/readme.md': 'dependency',
    'Shared/Team/linked/own.md': 'own',
    'Shared/Team/tool.exe': 'MZ',
  });
  const project = { id: 'p1', name: 'Alpha', sourceFolders: ['Shared/Team', 'Shared/Team/linked'], files: [{ name: 'upload.md', content: 'kept' }], assets: [] };
  const f = fixture(t, { baseUrl: d.baseUrl, project });
  const r = await f.post('sources/sync', {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const got = f.project.files.map((x) => [x.name, x.source || null]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  assert.deepEqual(got, [
    ['Shared/Team/docs/api/auth.md', 'Shared/Team'],
    ['Shared/Team/docs/readme.md', 'Shared/Team'],
    ['Shared/Team/linked/own.md', 'Shared/Team/linked'],
    ['Shared/Team/notes/2026/q4/plan.txt', 'Shared/Team'],
    ['Shared/Team/notes/readme.md', 'Shared/Team'],
    ['Shared/Team/top.md', 'Shared/Team'],
    ['upload.md', null],
  ]);
  assert.equal(f.project.files.find((x) => x.name === 'Shared/Team/docs/api/auth.md').content, 'auth');
  assert.deepEqual(r.body.skipped, []);
});

test('#1805: the project\'s own folder refresh keeps a folder import\'s nested files, so a refresh does not drop them', async (t) => {
  const d = await dav(t);
  d.dirs.add('noevia projects'); d.dirs.add(FOLDER);
  const f = fixture(t, { baseUrl: d.baseUrl, project: proj() });
  await f.importFolder({ 'docs/api/auth.md': 'auth', 'notes/readme.md': 'notes', 'readme.md': 'top' });
  const before = f.project.files.map((x) => x.name).sort();
  const r = await f.post('sources/sync', {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(f.project.files.map((x) => x.name).sort(), before);
  assert.equal(f.project.files.find((x) => x.name.endsWith('docs/api/auth.md')).content, 'auth');
});

test('#1805: a subfolder that cannot be listed keeps its previous sources and is reported, the rest still refresh', async (t) => {
  const d = await dav(t, { 'Shared/Team/a/one.md': 'one v2', 'Shared/Team/b/two.md': 'two' });
  const project = { id: 'p1', name: 'Alpha', sourceFolders: ['Shared/Team'], files: [{ name: 'Shared/Team/b/two.md', content: 'two v1', source: 'Shared/Team' }], assets: [] };
  const f = fixture(t, { baseUrl: d.baseUrl, project });
  d.failing.add('Shared/Team/b');
  const r = await f.post('sources/sync', {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const names = f.project.files.map((x) => [x.name, x.content]).sort();
  assert.ok(names.some(([n, c]) => n === 'Shared/Team/a/one.md' && c === 'one v2'));
  assert.ok(names.some(([n, c]) => n === 'Shared/Team/b/two.md' && c === 'two v1'), 'the unreadable subfolder kept its previous source: ' + JSON.stringify(names));
  assert.ok(r.body.skipped.some((s) => s.file === 'Shared/Team/b' && s.retained), JSON.stringify(r.body.skipped));
});

test('#1805 review: a manifest that declares 1 byte cannot carry a larger body; nothing is written', async (t) => {
  const d = await dav(t);
  d.dirs.add('noevia projects'); d.dirs.add(FOLDER);
  const f = fixture(t, { baseUrl: d.baseUrl, project: proj() });
  const plan = await f.post('folder-import/plan', { entries: [{ path: 'big.md', size: 1 }] });
  assert.deepEqual(plan.body.accepted.map((a) => [a.path, a.size]), [['big.md', 1]]);
  const r = await f.send(plan.body.importId, 'big.md', 'x'.repeat(4096));
  assert.equal(r.status, 413, JSON.stringify(r.body));
  assert.equal(r.body.code, 'sizeMismatch');
  assert.equal(d.files.size, 0);
  assert.deepEqual(f.project.files, []);
  assert.equal((await f.send(plan.body.importId, 'big.md', 'x')).status, 200, 'the declared size still goes through');
});

test('#1805 review: an upload whose path differs only in case from an existing source is refused', async (t) => {
  const d = await dav(t);
  d.dirs.add('noevia projects'); d.dirs.add(FOLDER);
  const f = fixture(t, { baseUrl: d.baseUrl, project: proj() });
  const stale = (await f.planOf({ 'docs/README.md': 'two' })).body; // planned while nothing clashed
  await f.importFolder({ 'docs/readme.md': 'one' });
  const plan = (await f.planOf({ 'docs/README.md': 'two' })).body;
  assert.deepEqual(plan.skipped.map((s) => s.code), ['caseCollision'], 'the plan refuses it now');
  const r = await f.send(stale.importId, 'docs/README.md', 'two');
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, 'caseCollision');
  assert.deepEqual([...d.files.keys()], [`${FOLDER}/Text/docs/readme.md`]);
});

test('#1805 review: the project source limit is one env-configurable value the upload path honours', async (t) => {
  const d = await dav(t);
  d.dirs.add('noevia projects'); d.dirs.add(FOLDER);
  const f = fixture(t, { baseUrl: d.baseUrl, project: proj() });
  process.env.PROJECT_SOURCE_LIMIT = '2';
  t.after(() => { delete process.env.PROJECT_SOURCE_LIMIT; });
  const { plan } = await f.importFolder({ 'a.md': 'A', 'b.md': 'B', 'c.md': 'C' });
  assert.equal(plan.limits.projectSources, 2);
  assert.equal(plan.limits.maxFiles, 2, 'the import cap follows the source limit');
  assert.deepEqual(plan.skipped.map((s) => [s.path, s.code]), [['c.md', 'fileLimit']]);
  const over = await f.post('upload', { name: 'd.md', organized: true, dataBase64: Buffer.from('D').toString('base64') });
  assert.equal(over.status, 400);
  assert.equal(over.body.code, 'projectLimit');
  assert.match(over.body.error, /at most 2 sources/);
  assert.equal(f.project.files.length, 2);
});
