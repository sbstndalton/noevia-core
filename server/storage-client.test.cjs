'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const test = require('node:test');

const { listFiles, readTextFile, createFolder, isBrowsable, safeRelativePath } = require('./storage-client.cjs');

// ── pure helpers ─────────────────────────────────────────────────────────────

test('safeRelativePath rejects escapes and odd segments', () => {
  assert.equal(safeRelativePath('a/b.md'), 'a/b.md');
  assert.equal(safeRelativePath('/absolute.md'), '');
  assert.equal(safeRelativePath('../escape.md'), '');
  assert.equal(safeRelativePath('a/../../escape.md'), '');
  assert.equal(safeRelativePath('./ok.md'), ''); // strict: segments only come from our own listings
  assert.equal(safeRelativePath(''), '');
  assert.equal(safeRelativePath(null), '');
});

test('isBrowsable covers remote kinds only', () => {
  assert.equal(isBrowsable({ kind: 'webdav' }), true);
  assert.equal(isBrowsable({ kind: 'nextcloud' }), true);
  assert.equal(isBrowsable({ kind: 's3' }), true);
  assert.equal(isBrowsable({ kind: 'local' }), false);
  assert.equal(isBrowsable(null), false);
});

// ── fake servers ─────────────────────────────────────────────────────────────

function startFakeDav() {
  // The connection root is a real directory now that browsing is no longer
  // prefixed with corpusRoot, so the fixture has to model it.
  const tree = {
    '': ['Cowork'],
    Cowork: ['Docs', '2026-09.md'],
    'Cowork/Docs': ['notes.md', 'huge.md', 'image.png'],
  };
  const bodies = {
    'Cowork/2026-09.md': 'month text',
    'Cowork/Docs/notes.md': '# notes\n\nremote knowledge',
    'Cowork/Docs/huge.md': 'x'.repeat(250_000),
    'Cowork/Docs/image.png': '\u0089PNG-data',
  };
  const server = http.createServer((req, res) => {
    const decoded = decodeURIComponent(req.url.split('?')[0]).replace(/\/+$/, '');
    const relative = decoded.replace(/^\/dav\/?/, '');
    if (req.method === 'PROPFIND') {
      if (relative === 'Unavailable') { res.writeHead(503); res.end(); return; }
      const children = tree[relative] || [];
      const self = relative ? relative.split('/').pop() : 'root';
      const xml = children.map((name) => {
        const childPath = relative ? `${relative}/${name}` : name;
        const isDir = !!tree[childPath];
        const size = isDir ? '' : `<getcontentlength>${(bodies[childPath] || '').length}</getcontentlength>`;
        return `<d:response><d:href>/dav/${encodeURI(childPath)}${isDir ? '/' : ''}</d:href>` +
          `<d:propstat><d:prop><d:resourcetype>${isDir ? '<d:collection/>' : ''}</d:resourcetype>${size}</d:prop></d:propstat></d:response>`;
      }).join('');
      res.writeHead(207, { 'Content-Type': 'application/xml' });
      res.end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${xml}</d:multistatus>`);
      return;
    }
    if (req.method === 'GET') {
      const body = bodies[relative];
      if (body === undefined) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    if (req.method === 'PUT') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        bodies[relative] = Buffer.concat(chunks).toString('utf8');
        const parent = relative.split('/').slice(0, -1).join('/');
        const name = relative.split('/').pop();
        if (tree[parent] && !tree[parent].includes(name)) tree[parent].push(name);
        res.writeHead(201); res.end();
      });
      return;
    }
    if (req.method === 'MKCOL') {
      if (tree[relative]) { res.writeHead(405); res.end(); return; } // already exists
      tree[relative] = [];
      const parent = relative.split('/').slice(0, -1).join('/');
      if (tree[parent]) tree[parent].push(relative.split('/').pop());
      res.writeHead(201);
      res.end();
      return;
    }
    res.writeHead(405);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function startFakeS3() {
  const objects = {
    'diary-bucket/Cowork/2026-09.md': 's3 month text',
    'diary-bucket/Cowork/Docs/notes.md': 's3 notes body',
    'diary-bucket/Cowork/Docs/binary.bin': 'not-text-but-listed',
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.searchParams.get('list-type') === '2') {
      const prefix = url.searchParams.get('prefix') || '';
      const delimiter = url.searchParams.get('delimiter') || '';
      const keys = Object.keys(objects).filter((k) => k.startsWith(`diary-bucket/${prefix}`));
      const commons = new Set();
      const contents = [];
      for (const key of keys) {
        const rel = key.slice('diary-bucket/'.length);
        const rest = rel.slice(prefix.length);
        if (delimiter && rest.includes(delimiter)) {
          commons.add(prefix + rest.split(delimiter)[0] + delimiter);
        } else if (rest) {
          contents.push(rel);
        }
      }
      let xml = '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>';
      for (const c of Array.from(commons).sort()) {
        xml += `<CommonPrefixes><Prefix>${c}</Prefix></CommonPrefixes>`;
      }
      for (const key of contents.sort()) {
        xml += `<Contents><Key>${key}</Key><Size>${Buffer.byteLength(objects[`diary-bucket/${key}`])}</Size></Contents>`;
      }
      xml += '</ListBucketResult>';
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end(xml);
      return;
    }
    const key = decodeURIComponent(url.pathname.replace(/^\/diary-bucket\//, ''));
    const body = objects[`diary-bucket/${key}`];
    if (body === undefined) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// ── client-level tests against the fakes ─────────────────────────────────────

test('webdav browsing is rooted at the connection, not at corpusRoot', async (t) => {
  const { server, port } = await startFakeDav();
  t.after(() => server.close());
  const conn = { kind: 'webdav', baseUrl: `http://127.0.0.1:${port}/dav`, username: 'u', secret: 'p', corpusRoot: 'Cowork' };

  // corpusRoot is where the diary keeps journal entries. Scoping every browse
  // to it meant a project could only attach sources from inside the diary
  // folder, so the whole connection is visible now and corpusRoot appears as
  // just another directory in it.
  const root = await listFiles(conn, '');
  assert.deepEqual(root.map((e) => [e.name, e.isDir]), [['Cowork', true]]);

  const docs = await listFiles(conn, 'Cowork/Docs');
  assert.deepEqual(docs.filter((e) => !e.isDir).map((e) => e.name), ['huge.md', 'image.png', 'notes.md']); // sorted

  const notes = await readTextFile(conn, 'Cowork/Docs/notes.md');
  assert.equal(notes.name, 'notes.md');
  assert.equal(notes.content, '# notes\n\nremote knowledge');

  // Oversized file is truncated to the cap, flagged.
  const huge = await readTextFile(conn, 'Cowork/Docs/huge.md');
  assert.equal(huge.truncated, true);
  assert.ok(huge.content.length <= 200_000);

  // Non-text extension rejected.
  await assert.rejects(() => readTextFile(conn, 'Cowork/Docs/image.png'), /not a supported text file/);
});

test('corpus scoping is still available for callers that want it', async (t) => {
  const { server, port } = await startFakeDav();
  t.after(() => server.close());
  const conn = { kind: 'webdav', baseUrl: `http://127.0.0.1:${port}/dav`, username: 'u', secret: 'p', corpusRoot: 'Cowork' };

  const scoped = await listFiles(conn, '', { scope: 'corpus' });
  assert.deepEqual(scoped.map((e) => [e.name, e.isDir]), [['2026-09.md', false], ['Docs', true]]);

  const notes = await readTextFile(conn, 'Docs/notes.md', { scope: 'corpus' });
  assert.equal(notes.content, '# notes\n\nremote knowledge');
});

test('createFolder makes a directory, tolerates one that exists, and refuses S3', async (t) => {
  const { server, port } = await startFakeDav();
  t.after(() => server.close());
  const conn = { kind: 'webdav', baseUrl: `http://127.0.0.1:${port}/dav`, username: 'u', secret: 'p', corpusRoot: 'Cowork' };

  const made = await createFolder(conn, 'Cowork/Fresh');
  assert.deepEqual(made, { path: 'Cowork/Fresh', existed: false });
  assert.ok((await listFiles(conn, 'Cowork')).some((e) => e.name === 'Fresh' && e.isDir));

  // MKCOL on an existing collection answers 405; that is not a failure.
  assert.deepEqual(await createFolder(conn, 'Cowork/Fresh'), { path: 'Cowork/Fresh', existed: true });

  // Traversal cannot escape, and an empty path is rejected outright.
  await assert.rejects(() => createFolder(conn, '../escape'), /invalid folder path/);
  await assert.rejects(() => createFolder(conn, ''), /invalid folder path/);

  // S3 has no directories, so claiming to have made one would be a lie.
  const s3 = { kind: 's3', baseUrl: 'http://127.0.0.1:1', bucket: 'b', username: 'ak', secret: 'sk' };
  await assert.rejects(() => createFolder(s3, 'anything'), /S3 has no folders/);
});

test('s3 listFiles and readTextFile honor the connection-relative contract', async (t) => {
  const { server, port } = await startFakeS3();
  t.after(() => server.close());
  const conn = { kind: 's3', baseUrl: `http://127.0.0.1:${port}`, bucket: 'diary-bucket', username: 'ak', secret: 'sk', corpusRoot: 'Cowork' };

  const root = await listFiles(conn, '');
  assert.deepEqual(root.map((e) => [e.name, e.isDir]), [['2026-09.md', false], ['Docs', true]]); // sorted

  const docs = await listFiles(conn, 'Docs');
  assert.deepEqual(docs.map((e) => [e.name, e.isDir]), [['binary.bin', false], ['notes.md', false]]);

  const notes = await readTextFile(conn, 'Docs/notes.md');
  assert.equal(notes.content, 's3 notes body');

  await assert.rejects(() => readTextFile(conn, 'Docs/binary.bin'), /not a supported text file/);
  await assert.rejects(() => readTextFile(conn, 'nope.md'), /storage returned 404/);
});

// ── route-level tests (fake WebDAV behind the real proxy routes) ─────────────

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-storage-client-test-'));
process.env.DIARY_AUTH_TOKEN = 'test-cowork-token';
process.env.UI_DATA_DIR = testDataDir;
process.env.LEGACY_AUTH_COMPAT = 'true';
process.env.PUBLIC_ORIGIN = 'http://localhost';

const { handleRequest } = require('./index.cjs');

test.after(() => {
  if (sharedDav) sharedDav.server.close();
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

async function request(url, { method = 'GET', headers = {}, body = '' } = {}) {
  const req = Readable.from(body ? [body] : []);
  req.url = url;
  req.method = method;
  req.headers = { host: 'localhost', ...headers };
  const chunks = [];
  const responseHeaders = {};
  const res = new Writable({
    write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); },
  });
  res.statusCode = 200;
  res.headersSent = false;
  res.setHeader = (name, value) => { responseHeaders[name] = value; };
  res.writeHead = (status, nextHeaders = {}) => {
    res.statusCode = status;
    res.headersSent = true;
    Object.assign(responseHeaders, nextHeaders);
    return res;
  };
  const finished = new Promise((resolve, reject) => {
    res.once('finish', resolve);
    res.once('error', reject);
  });
  await handleRequest(req, res);
  await finished;
  return { status: res.statusCode, headers: responseHeaders, text: Buffer.concat(chunks).toString('utf8') };
}

let cookie = '';
let csrf = '';
let sharedDav = null;

test.before(async () => {
  sharedDav = await startFakeDav();
  const setupCode = fs.readFileSync(path.join(testDataDir, 'first-run-setup-code'), 'utf8').trim();
  const setup = await request('/api/setup/complete', {
    method: 'POST', headers: { origin: 'http://localhost' },
    body: JSON.stringify({ setupCode, publicOrigin: 'http://localhost', username: 'admin', displayName: 'Admin', password: 'correct horse battery staple' }),
  });
  assert.equal(setup.status, 201);
  const login = await request('/api/auth/login/password', {
    method: 'POST', headers: { origin: 'http://localhost' },
    body: JSON.stringify({ username: 'admin', password: 'correct horse battery staple' }),
  });
  const setCookies = login.headers['set-cookie'] || login.headers['Set-Cookie'] || [];
  cookie = setCookies.map((c) => c.split(';')[0]).join('; ');
  const csrfPair = setCookies.map((c) => c.split(';')[0]).find((c) => c.startsWith('cowork_csrf='));
  csrf = decodeURIComponent(csrfPair.split('=').slice(1).join('='));
  // Connect the fake WebDAV as the user's storage.
  const save = await request('/api/integrations/storage', {
    method: 'PUT',
    headers: { origin: 'http://localhost', cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
    body: JSON.stringify({ kind: 'webdav', baseUrl: `http://127.0.0.1:${sharedDav.port}/dav`, username: 'u', secret: 'p', corpusRoot: 'Cowork' }),
  });
  assert.equal(save.status, 200);
});

const mutationHeaders = () => ({ origin: 'http://localhost', cookie, 'content-type': 'application/json', 'x-csrf-token': csrf });

test('browse route lists the connected WebDAV root through the proxy', async (t) => {
  const response = await request('/api/integrations/storage/files', { headers: { cookie } });
  assert.equal(response.status, 200);
  const body = JSON.parse(response.text);
  assert.deepEqual(body.entries.map((e) => [e.name, e.isDir]), [['Cowork', true]]);
});

test('browse route serves a nested directory and rejects traversal', async () => {
  const nested = await request('/api/integrations/storage/files/Cowork/Docs', { headers: { cookie } });
  assert.equal(nested.status, 200);
  assert.ok(JSON.parse(nested.text).entries.some((e) => e.name === 'notes.md'));

  const evil = await request('/api/integrations/storage/files/..%2F..%2Fetc', { headers: { cookie } });
  // Traversal is neutralized to '' (root listing), never an escape.
  assert.equal(evil.status, 200);
});

test('file-read route returns content and enforces the text-extension rule', async () => {
  const good = await request('/api/integrations/storage/file', {
    method: 'POST', headers: mutationHeaders(),
    body: JSON.stringify({ path: 'Cowork/Docs/notes.md' }),
  });
  assert.equal(good.status, 200);
  assert.equal(JSON.parse(good.text).content, '# notes\n\nremote knowledge');

  const bad = await request('/api/integrations/storage/file', {
    method: 'POST', headers: mutationHeaders(),
    body: JSON.stringify({ path: 'Docs/image.png' }),
  });
  assert.equal(bad.status, 400);
  assert.match(JSON.parse(bad.text).error, /not a supported text file/);
});

test('browse route requires authentication', async () => {
  const response = await request('/api/integrations/storage/files');
  assert.equal(response.status, 401);
});


async function createTestProject(name, extra = {}) {
  const result = await request('/api/projects', { method: 'POST', headers: mutationHeaders(), body: JSON.stringify({ name, ...extra }) });
  assert.equal(result.status, 200, result.text);
  return JSON.parse(result.text);
}

async function workspaceProject(id) {
  const result = await request('/api/workspace', { headers: { cookie } });
  return JSON.parse(result.text).projects.find((p) => p.id === id);
}

test('same-name projects receive distinct storage folders', async () => {
  const one = await createTestProject('Same name');
  const two = await createTestProject('Same name');
  assert.notEqual(one.projectFolder, two.projectFolder);
});

test('a rejected config patch leaves every previous field unchanged', async () => {
  const project = await createTestProject('Atomic settings');
  const result = await request(`/api/projects/${project.id}/config`, { method: 'POST', headers: mutationHeaders(), body: JSON.stringify({ name: 'Should not save', routing: 'invalid' }) });
  assert.equal(result.status, 400);
  assert.equal((await workspaceProject(project.id)).name, 'Atomic settings');
});

test('a temporary folder failure preserves its sources, while explicit detachment removes them', async () => {
  const project = await createTestProject('Resilient sources');
  await request(`/api/projects/${project.id}/config`, { method: 'POST', headers: mutationHeaders(), body: JSON.stringify({ sourceFolders: ['Cowork/Docs'] }) });
  const syncUrl = `/api/projects/${project.id}/sources/sync`;
  assert.equal((await request(syncUrl, { method: 'POST', headers: mutationHeaders() })).status, 200);
  const before = await workspaceProject(project.id);
  assert.ok(before.files.some((f) => f.name.endsWith('notes.md')));
  // Inject a transient transport failure at the storage boundary, not in the route.
  const client = require('./storage-client.cjs');
  const list = client.listFiles;
  client.listFiles = async () => { throw new Error('storage offline'); };
  try {
    const sync = JSON.parse((await request(syncUrl, { method: 'POST', headers: mutationHeaders() })).text);
    assert.equal(sync.skipped.length, 1);
    assert.deepEqual((await workspaceProject(project.id)).files, before.files);
  } finally { client.listFiles = list; }
  await request(`/api/projects/${project.id}/config`, { method: 'POST', headers: mutationHeaders(), body: JSON.stringify({ sourceFolders: [] }) });
  await request(syncUrl, { method: 'POST', headers: mutationHeaders() });
  assert.deepEqual((await workspaceProject(project.id)).files, []);
});

test('uploads work without remote storage and gain a folder after connecting it', async () => {
  const client = require('./storage-client.cjs');
  const browsable = client.isBrowsable;
  client.isBrowsable = () => false;
  let project;
  try {
    project = await createTestProject('Local uploads');
    assert.equal(project.projectFolder, undefined);
    const result = await request(`/api/projects/${project.id}/upload`, { method: 'POST', headers: mutationHeaders(), body: JSON.stringify({ name: 'local.txt', dataBase64: Buffer.from('local knowledge').toString('base64') }) });
    assert.equal(result.status, 200, result.text);
    assert.equal((await workspaceProject(project.id)).files[0].content, 'local knowledge');
  } finally { client.isBrowsable = browsable; }
  const result = await request(`/api/projects/${project.id}/upload`, { method: 'POST', headers: mutationHeaders(), body: JSON.stringify({ name: 'remote.txt', dataBase64: Buffer.from('remote knowledge').toString('base64') }) });
  assert.equal(result.status, 200, result.text);
  const after = await workspaceProject(project.id);
  assert.ok(after.projectFolder);
  assert.ok(after.sourceFolders.includes(after.projectFolder));
  assert.ok(after.files.some((f) => f.name === 'local.txt'));
});

test('repeated tool calls in separate inference rounds keep distinct UI identities', async () => {
  const project = await createTestProject('Multi-round tools', { model: 'test-model' });
  const originalFetch = global.fetch;
  let rounds = 0;
  global.fetch = async () => {
    rounds++;
    const delta = rounds <= 2
      ? { tool_calls: [{ index: 0, id: `call-${rounds}`, function: { name: 'get_current_time', arguments: '{}' } }] }
      : { content: 'Both calls completed.' };
    return new Response(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
  };
  try {
    const response = await request('/api/chat', { method: 'POST', headers: mutationHeaders(), body: JSON.stringify({ projectId: project.id, spaceId: project.id, message: 'Use the clock twice', history: [] }) });
    assert.equal(response.status, 200, response.text);
    const events = response.text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
    assert.deepEqual(events.filter((e) => e.type === 'tool').map((e) => e.index), [0, 1]);
    assert.deepEqual(events.filter((e) => e.type === 'tool_result').map((e) => e.index), [0, 1]);
    assert.ok(events.some((e) => e.type === 'delta' && e.text === 'Both calls completed.'));
  } finally { global.fetch = originalFetch; }
});

test('an in-flight sync preserves concurrent uploads and does not restore detached folders', async () => {
  const project = await createTestProject('Concurrent sources');
  const config = (patch) => request(`/api/projects/${project.id}/config`, { method: 'POST', headers: mutationHeaders(), body: JSON.stringify(patch) });
  await config({ sourceFolders: ['Cowork/Docs'] });
  const client = require('./storage-client.cjs');
  const list = client.listFiles;
  let release; let started;
  const blocked = new Promise((r) => { release = r; });
  const entered = new Promise((r) => { started = r; });
  client.listFiles = async (...args) => { started(); await blocked; return list(...args); };
  try {
    const syncing = request(`/api/projects/${project.id}/sources/sync`, { method: 'POST', headers: mutationHeaders() });
    await entered;
    await config({ sourceFolders: [], files: [{ name: 'during.txt', content: 'uploaded while syncing' }] });
    release();
    assert.equal((await syncing).status, 200);
    assert.deepEqual((await workspaceProject(project.id)).files, [{ name: 'during.txt', content: 'uploaded while syncing' }]);
  } finally { release(); client.listFiles = list; }
});

test('base64 overhead does not reject images below the advertised 8 MB cap', async () => {
  const project = await createTestProject('Large image');
  const response = await request(`/api/projects/${project.id}/assets`, { method: 'POST', headers: mutationHeaders(), body: JSON.stringify({ name: 'large.png', mime: 'image/png', dataBase64: Buffer.alloc(7 * 1024 * 1024).toString('base64') }) });
  assert.equal(response.status, 200, response.text);
  assert.equal(JSON.parse(response.text).asset.bytes, 7 * 1024 * 1024);
});
