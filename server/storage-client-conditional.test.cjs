'use strict';
// #648: the WebDAV calls an in-place edit relies on. fileVersion reports whether a file exists and
// its ETag; writeFile with ifMatch sends If-Match and turns a 412 into a `changed` error with
// nothing written. A synthetic HTTP server only.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { fileVersion, writeFile } = require('./storage-client.cjs');

function startDav(t) {
  const files = new Map([['Docs/notes.md', { body: 'v1', etag: '"e1"' }], ['Docs/bare.md', { body: 'b', etag: '' }]]);
  const seen = [];
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(req.url).replace(/^\/dav\//, '').replace(/\/+$/, '');
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen.push({ method: req.method, path: p, depth: req.headers.depth, ifMatch: req.headers['if-match'], ifNoneMatch: req.headers['if-none-match'] });
      if (req.method === 'PROPFIND') {
        if (p === 'Docs') { res.writeHead(207); return res.end('<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/Docs/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype><d:getetag>"dir"</d:getetag></d:prop></d:propstat></d:response></d:multistatus>'); }
        const f = files.get(p);
        if (!f) { res.writeHead(404); return res.end(); }
        res.writeHead(207);
        return res.end(`<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/${p}</d:href><d:propstat><d:prop><d:resourcetype/>${f.etag ? `<d:getetag>${f.etag.replace(/"/g, '&quot;')}</d:getetag>` : ''}</d:prop></d:propstat></d:response></d:multistatus>`);
      }
      if (req.method === 'PUT') {
        const f = files.get(p);
        if (req.headers['if-match'] && (!f || f.etag !== req.headers['if-match'])) { res.writeHead(412); return res.end(); }
        if (req.headers['if-none-match'] === '*' && f) { res.writeHead(412); return res.end(); }
        files.set(p, { body: raw, etag: `"w${seen.length}"` });
        res.writeHead(201); return res.end();
      }
      res.writeHead(405); res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    t.after(() => new Promise((r) => server.close(r)));
    resolve({ conn: { kind: 'webdav', baseUrl: `http://127.0.0.1:${server.address().port}/dav`, username: 'u', secret: 's' }, files, seen });
  }));
}

test('fileVersion: an ETag, an empty ETag, a 404, and a folder', async (t) => {
  const { conn, seen } = await startDav(t);
  assert.deepEqual(await fileVersion(conn, 'Docs/notes.md'), { exists: true, etag: '"e1"' });
  assert.equal(seen[0].depth, '0', 'one resource, not a listing');
  assert.deepEqual(await fileVersion(conn, 'Docs/bare.md'), { exists: true, etag: '' });
  assert.deepEqual(await fileVersion(conn, 'Docs/gone.md'), { exists: false });
  await assert.rejects(() => fileVersion(conn, 'Docs'), /is a folder in storage/);
  await assert.rejects(() => fileVersion(conn, '../escape.md'), /invalid path/);
  await assert.rejects(() => fileVersion({ kind: 's3' }, 'Docs/notes.md'), /cannot report a file version/);
});

test('writeFile with ifMatch sends If-Match; a 412 is a changed error and nothing is written', async (t) => {
  const { conn, files, seen } = await startDav(t);
  await writeFile(conn, 'Docs/notes.md', Buffer.from('v2'), { ifMatch: '"e1"' });
  assert.equal(seen.at(-1).ifMatch, '"e1"');
  assert.equal(files.get('Docs/notes.md').body, 'v2');
  // The ETag has moved on since: 412, and the stored body stays.
  await assert.rejects(() => writeFile(conn, 'Docs/notes.md', Buffer.from('v3'), { ifMatch: '"e1"' }), (e) => e.code === 'changed' && /changed in storage/.test(e.message));
  assert.equal(files.get('Docs/notes.md').body, 'v2');
  // A missing file with If-Match is not created.
  await assert.rejects(() => writeFile(conn, 'Docs/gone.md', Buffer.from('x'), { ifMatch: '"e1"' }), (e) => e.code === 'changed');
  assert.equal(files.has('Docs/gone.md'), false);
  // A header-splitting value is refused before any request.
  const count = seen.length;
  await assert.rejects(() => writeFile(conn, 'Docs/notes.md', Buffer.from('x'), { ifMatch: 'e1\r\nX: y' }), /invalid If-Match/);
  assert.equal(seen.length, count);
  // Without ifMatch nothing changes: no header.
  await writeFile(conn, 'Docs/new.md', Buffer.from('n'));
  assert.equal(seen.at(-1).ifMatch, undefined);
});

test('#687: writeFile with ifNoneMatch creates only; an existing file is a changed error and stays', async (t) => {
  const { conn, files, seen } = await startDav(t);
  await writeFile(conn, 'Docs/fresh.md', Buffer.from('new'), { ifNoneMatch: '*' });
  assert.equal(seen.at(-1).ifNoneMatch, '*');
  assert.equal(files.get('Docs/fresh.md').body, 'new');
  await assert.rejects(() => writeFile(conn, 'Docs/notes.md', Buffer.from('clobber'), { ifNoneMatch: '*' }), (e) => e.code === 'changed' && /already exists/.test(e.message));
  assert.equal(files.get('Docs/notes.md').body, 'v1');
  const count = seen.length;
  await assert.rejects(() => writeFile(conn, 'Docs/x.md', Buffer.from('x'), { ifNoneMatch: '"e1"' }), /invalid If-None-Match/);
  await assert.rejects(() => writeFile(conn, 'Docs/x.md', Buffer.from('x'), { ifNoneMatch: '*', ifMatch: '"e1"' }), /cannot be combined/);
  assert.equal(seen.length, count, 'refused before any request');
});
