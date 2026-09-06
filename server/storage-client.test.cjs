'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const test = require('node:test');

const { listFiles, readTextFile, isBrowsable, safeRelativePath } = require('./storage-client.cjs');

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
  // Paths are nested under the users' corpusRoot (Cowork) — the client always
  // requests full DAV paths that include it.
  const tree = {
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
    const relative = decoded.replace(/^\/dav\//, '');
    if (req.method === 'PROPFIND') {
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

test('webdav listFiles and readTextFile honor the corpusRoot-relative contract', async (t) => {
  const { server, port } = await startFakeDav();
  t.after(() => server.close());
  const conn = { kind: 'webdav', baseUrl: `http://127.0.0.1:${port}/dav`, username: 'u', secret: 'p', corpusRoot: 'Cowork' };

  const root = await listFiles(conn, '');
  assert.deepEqual(root.map((e) => [e.name, e.isDir]), [['2026-09.md', false], ['Docs', true]]);

  const docs = await listFiles(conn, 'Docs');
  assert.deepEqual(docs.filter((e) => !e.isDir).map((e) => e.name), ['huge.md', 'image.png', 'notes.md']); // sorted

  const notes = await readTextFile(conn, 'Docs/notes.md');
  assert.equal(notes.name, 'notes.md');
  assert.equal(notes.content, '# notes\n\nremote knowledge');

  // Oversized file is truncated to the cap, flagged.
  const huge = await readTextFile(conn, 'Docs/huge.md');
  assert.equal(huge.truncated, true);
  assert.ok(huge.content.length <= 200_000);

  // Non-text extension rejected.
  await assert.rejects(() => readTextFile(conn, 'Docs/image.png'), /not a supported text file/);
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
  assert.deepEqual(body.entries.map((e) => [e.name, e.isDir]), [['2026-09.md', false], ['Docs', true]]);
});

test('browse route serves a nested directory and rejects traversal', async () => {
  const nested = await request('/api/integrations/storage/files/Docs', { headers: { cookie } });
  assert.equal(nested.status, 200);
  assert.ok(JSON.parse(nested.text).entries.some((e) => e.name === 'notes.md'));

  const evil = await request('/api/integrations/storage/files/..%2F..%2Fetc', { headers: { cookie } });
  // Traversal is neutralized to '' (root listing), never an escape.
  assert.equal(evil.status, 200);
});

test('file-read route returns content and enforces the text-extension rule', async () => {
  const good = await request('/api/integrations/storage/file', {
    method: 'POST', headers: mutationHeaders(),
    body: JSON.stringify({ path: 'Docs/notes.md' }),
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
