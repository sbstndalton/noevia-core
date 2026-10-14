'use strict';
// #1664: writeFile reports the ETag the server gave the written file; discardWritten removes exactly
// that version (DELETE with If-Match), keeps a file changed since (412), never sends an unconditional
// DELETE, skips S3, and never throws. A synthetic HTTP server only.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { writeFile, discardWritten } = require('./storage-client.cjs');

function startDav(t, { etagHeader = true, deleteStatus, ignoreIfNoneMatch = false } = {}) {
  const files = new Map();
  const seen = [];
  let n = 0;
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(req.url).replace(/^\/dav\//, '');
    req.resume();
    req.on('end', () => {
      seen.push({ method: req.method, path: p, ifMatch: req.headers['if-match'] });
      if (req.method === 'PUT') {
        if (!ignoreIfNoneMatch && req.headers['if-none-match'] === '*' && files.has(p)) { res.writeHead(412); return res.end(); }
        const had = files.has(p);
        const etag = `"v${++n}"`; files.set(p, etag);
        res.writeHead(had ? 204 : 201, etagHeader ? { ETag: etag } : {}); return res.end();
      }
      if (req.method === 'DELETE') {
        if (deleteStatus) { res.writeHead(deleteStatus); return res.end(); }
        if (!files.has(p)) { res.writeHead(404); return res.end(); }
        if (req.headers['if-match'] !== files.get(p)) { res.writeHead(412); return res.end(); }
        files.delete(p); res.writeHead(204); return res.end();
      }
      res.writeHead(405); res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    t.after(() => new Promise((r) => server.close(r)));
    resolve({ conn: { kind: 'webdav', baseUrl: `http://127.0.0.1:${server.address().port}/dav`, username: 'u', secret: 's' }, files, seen });
  }));
}

test('#1664: a create-only write returns its ETag, and discardWritten deletes that version with If-Match', async (t) => {
  const d = await startDav(t);
  const w = await writeFile(d.conn, 'P/a.md', Buffer.from('x'), { ifNoneMatch: '*' });
  assert.deepEqual(w, { path: 'P/a.md', etag: '"v1"', created: true });
  assert.deepEqual(await discardWritten(d.conn, 'P/a.md', w.etag), { deleted: true });
  assert.deepEqual(d.seen.at(-1), { method: 'DELETE', path: 'P/a.md', ifMatch: '"v1"' });
  assert.equal(d.files.has('P/a.md'), false);
});

test('#1664: a file rewritten since keeps its new version (412), and nothing throws', async (t) => {
  const d = await startDav(t);
  const w = await writeFile(d.conn, 'P/a.md', Buffer.from('x'), { ifNoneMatch: '*' });
  await writeFile(d.conn, 'P/a.md', Buffer.from('someone else'));
  assert.deepEqual(await discardWritten(d.conn, 'P/a.md', w.etag), { deleted: false, reason: 'changed' });
  assert.equal(d.files.get('P/a.md'), '"v2"');
});

test('#1664: without an ETag, on S3, or when the server fails, nothing unconditional is sent and nothing throws', async (t) => {
  const d = await startDav(t, { etagHeader: false });
  const w = await writeFile(d.conn, 'P/a.md', Buffer.from('x'), { ifNoneMatch: '*' });
  assert.equal(w.etag, '');
  assert.deepEqual(await discardWritten(d.conn, 'P/a.md', w.etag), { deleted: false, reason: 'no-etag' });
  assert.equal(d.seen.filter((s) => s.method === 'DELETE').length, 0);
  assert.deepEqual(await discardWritten({ kind: 's3', baseUrl: 'http://127.0.0.1:1', bucket: 'b' }, 'P/a.md', '"v1"'), { deleted: false, reason: 's3' });
  const broken = await startDav(t, { deleteStatus: 500 });
  assert.deepEqual(await discardWritten(broken.conn, 'P/a.md', '"v1"'), { deleted: false, reason: 'status-500' });
  const down = await discardWritten({ kind: 'webdav', baseUrl: 'http://127.0.0.1:1/dav', username: 'u', secret: 's' }, 'P/a.md', '"v1"');
  assert.equal(down.deleted, false);
  assert.equal(down.reason, 'error');
});

test('#1664 review: a server that ignores If-None-Match overwrites with 204, which is not "created"', async (t) => {
  const d = await startDav(t, { ignoreIfNoneMatch: true });
  await writeFile(d.conn, 'P/report.pdf', Buffer.from('the user\'s own file'));
  const w = await writeFile(d.conn, 'P/report.pdf', Buffer.from('upload'), { ifNoneMatch: '*' });
  assert.equal(w.created, false, 'an overwrite of an existing file must never be discarded by the caller');
});
