'use strict';
// Regressions for the storage client from the 2026-10-05 hardening sweep. Synthetic HTTP
// servers on 127.0.0.1 only.
//   #784  deleteFile refuses a WebDAV collection (a DELETE of one is recursive), never sends a
//         DELETE for a path it could not confirm is a file, and still refuses S3 outright
//   #787  PROPFIND bodies are parsed by a forward-only scan: a hostile body of unclosed tags at
//         the 4 MB listing cap parses in bounded time, with the same matches as before
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { deleteFile, listFiles, fileVersion, removeEmptyFolder, elementTexts } = require('./storage-client.cjs');

function startDav(t, { propfindStatus = null, afterPropfind = null } = {}) {
  const files = new Map([['Docs/notes.md', '"e1"'], ['Docs/other.md', '"e2"'], ['Docs/no-etag.md', '']]);
  const dirs = new Set(['Docs', 'Docs/sub', 'Docs/attr']);
  const seen = [];
  const collection = (p) => (p === 'Docs/attr' ? '<d:collection xmlns:d="DAV:" />' : '<d:collection/>');
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(req.url).replace(/^\/dav\//, '').replace(/\/+$/, '');
    req.resume();
    req.on('end', () => {
      seen.push({ method: req.method, path: p, depth: req.headers.depth, ifMatch: req.headers['if-match'] });
      if (req.method === 'PROPFIND') {
        if (propfindStatus) { res.writeHead(propfindStatus); return res.end(); }
        if (dirs.has(p)) { res.writeHead(207); return res.end(`<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/${p}/</d:href><d:propstat><d:prop><d:resourcetype>${collection(p)}</d:resourcetype><d:getetag>"dir"</d:getetag></d:prop></d:propstat></d:response></d:multistatus>`); }
        if (!files.has(p)) { res.writeHead(404); return res.end(); }
        const etag = files.get(p);
        res.writeHead(207);
        res.end(`<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/${p}</d:href><d:propstat><d:prop><d:resourcetype/>${etag ? `<d:getetag>${etag.replace(/"/g, '&quot;')}</d:getetag>` : ''}</d:prop></d:propstat></d:response></d:multistatus>`);
        if (afterPropfind) afterPropfind({ files, dirs, path: p });
        return;
      }
      if (req.method === 'DELETE') {
        // A real WebDAV server deletes a collection recursively; record it so a test can fail on it.
        const ifMatch = req.headers['if-match'];
        if (dirs.has(p)) {
          if (ifMatch && ifMatch !== '"dir"') { res.writeHead(412); return res.end(); }
          dirs.delete(p); res.writeHead(204); return res.end();
        }
        if (!files.has(p)) { res.writeHead(404); return res.end(); }
        if (ifMatch && ifMatch !== files.get(p)) { res.writeHead(412); return res.end(); }
        files.delete(p); res.writeHead(204); return res.end();
      }
      res.writeHead(405); res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    t.after(() => new Promise((r) => server.close(r)));
    resolve({ conn: { kind: 'webdav', baseUrl: `http://127.0.0.1:${server.address().port}/dav`, username: 'u', secret: 's' }, files, dirs, seen });
  }));
}

test('#784: deleteFile deletes a file after confirming it is one', async (t) => {
  const { conn, files, seen } = await startDav(t);
  assert.deepEqual(await deleteFile(conn, 'Docs/notes.md'), { path: 'Docs/notes.md', missing: false });
  assert.deepEqual(seen.map((s) => [s.method, s.path, s.depth, s.ifMatch]), [['PROPFIND', 'Docs/notes.md', '0', undefined], ['DELETE', 'Docs/notes.md', undefined, '"e1"']],
    'the DELETE is conditional on the ETag the check saw');
  assert.equal(files.has('Docs/notes.md'), false);
  assert.deepEqual(await deleteFile(conn, 'Docs/no-etag.md'), { path: 'Docs/no-etag.md', missing: false });
  assert.equal(seen.at(-1).ifMatch, undefined, 'a server that reports no ETag gets an unconditional DELETE');
});

test('#784: a path that changes between the check and the DELETE is refused with 409 and kept', async (t) => {
  // Between the PROPFIND and the DELETE the file is replaced (here: a new ETag; a file turned
  // into a folder looks the same to an If-Match).
  const { conn, files } = await startDav(t, { afterPropfind: ({ files: f, path: p }) => { if (f.has(p)) f.set(p, '"e1-changed"'); } });
  await assert.rejects(() => deleteFile(conn, 'Docs/notes.md'), (e) => e.status === 409 && e.code === 'changed' && /changed in storage/.test(e.message));
  assert.equal(files.get('Docs/notes.md'), '"e1-changed"', 'the changed file is still there');
});

test('#784: a collection element carrying attributes is still recognised as a folder', async (t) => {
  const { conn, dirs, seen } = await startDav(t);
  await assert.rejects(() => fileVersion(conn, 'Docs/attr'), (e) => e.code === 'folder');
  await assert.rejects(() => deleteFile(conn, 'Docs/attr'), (e) => e.status === 400 && e.code === 'folder');
  assert.ok(dirs.has('Docs/attr'));
  assert.ok(!seen.some((s) => s.method === 'DELETE'));
});

test('#784: deleteFile refuses a collection, including one reached through a backslash, and sends no DELETE', async (t) => {
  const { conn, dirs, seen } = await startDav(t);
  for (const target of ['Docs/sub', 'Docs\\sub', 'Docs']) {
    await assert.rejects(() => deleteFile(conn, target), (e) => e.status === 400 && e.code === 'folder' && /is a folder/.test(e.message), target);
  }
  assert.ok(!seen.some((s) => s.method === 'DELETE'), 'no DELETE ever reaches a collection');
  assert.ok(dirs.has('Docs/sub') && dirs.has('Docs'));
});

test('#784: a missing path sends no DELETE, and an unsettled answer refuses rather than guessing', async (t) => {
  const missing = await startDav(t);
  assert.deepEqual(await deleteFile(missing.conn, 'Docs/gone.md'), { path: 'Docs/gone.md', missing: true });
  assert.ok(!missing.seen.some((s) => s.method === 'DELETE'));

  const broken = await startDav(t, { propfindStatus: 500 });
  await assert.rejects(() => deleteFile(broken.conn, 'Docs/notes.md'), (e) => e.status === 502);
  assert.ok(!broken.seen.some((s) => s.method === 'DELETE'), 'a server that cannot say what the path is gets no DELETE');
  assert.ok(broken.files.has('Docs/notes.md'));
});

test('#784: deleteFile still refuses S3 and an invalid path before any request', async () => {
  const realFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls += 1; throw new Error('no request expected'); };
  try {
    await assert.rejects(() => deleteFile({ kind: 's3', baseUrl: 'http://127.0.0.1:1', bucket: 'b' }, 'Docs/notes.md'), (e) => e.status === 400 && /S3 is not supported/.test(e.message));
    await assert.rejects(() => deleteFile({ kind: 'webdav', baseUrl: 'http://127.0.0.1:1' }, '../escape.md'), (e) => e.status === 400 && /invalid path/.test(e.message));
    assert.equal(calls, 0);
  } finally { global.fetch = realFetch; }
});

// ── #787 ──────────────────────────────────────────────────────────────────────

const OLD_PATTERN = (name) => new RegExp(`<(?:[a-zA-Z0-9]+:)?${name}>([\\s\\S]*?)<\\/(?:[a-zA-Z0-9]+:)?${name}>`, 'g');

test('#787: the forward-only scan finds exactly what the old lazy regex found', () => {
  const bodies = [
    '',
    'no tags at all',
    '<d:multistatus><d:response>a</d:response><d:response>b</d:response></d:multistatus>',
    '<response>plain</response><D:response>upper</D:response><d:response>mixed</D:response>',
    '<d:response>unclosed <d:response>inner</d:response> tail <d:response>never closed',
    '<d:responses>not it</d:responses><d:response >spaced</d:response><d:response>ok</d:response>',
    '<a:b:response>double prefix</a:b:response><x1:response>digits</x1:response>',
    '</d:response><d:response>after a stray close</d:response><',
    '<d:response><d:href>/a</d:href><d:href>/b</d:href></d:response>',
    '<<d:response>>doubled<</d:response>>',
    '<:response>empty prefix</:response><response>x</response>',
  ];
  for (const body of bodies) {
    for (const name of ['response', 'href']) {
      const expected = [...body.matchAll(OLD_PATTERN(name))].map((m) => m[1]);
      assert.deepEqual(elementTexts(body, name), expected, `${name} in ${JSON.stringify(body)}`);
      assert.deepEqual(elementTexts(body, name, 1), expected.slice(0, 1));
    }
  }
});

function startRaw(t, body) {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => { res.writeHead(207, { 'Content-Type': 'application/xml' }); res.end(body); });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    t.after(() => new Promise((r) => server.close(r)));
    resolve({ kind: 'webdav', baseUrl: `http://127.0.0.1:${server.address().port}/dav`, username: 'u', secret: 's' });
  }));
}

const FOUR_MB = 4 * 1024 * 1024;
const unclosed = (tag) => tag.repeat(Math.floor(FOUR_MB / tag.length));

test('#787: a 4 MB body of unclosed response tags parses in bounded time', async (t) => {
  const body = unclosed('<d:response>');
  const started = process.hrtime.bigint();
  assert.deepEqual(elementTexts(body, 'response'), []);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms < 1000, `scan took ${ms.toFixed(0)} ms`);

  const conn = await startRaw(t, body);
  const listedAt = process.hrtime.bigint();
  assert.deepEqual(await listFiles(conn, 'Docs'), []);
  const listMs = Number(process.hrtime.bigint() - listedAt) / 1e6;
  assert.ok(listMs < 1000, `listing took ${listMs.toFixed(0)} ms`);
});

test('#787: unclosed href tags inside one huge response block also parse in bounded time', async (t) => {
  const body = `<d:multistatus><d:response>${unclosed('<d:href>')}</d:response></d:multistatus>`;
  const conn = await startRaw(t, body);
  for (const [label, run] of [
    ['listFiles', () => listFiles(conn, 'Docs')],
    ['removeEmptyFolder', () => removeEmptyFolder(conn, 'Docs/empty')],
    ['fileVersion', () => fileVersion(conn, 'Docs/notes.md')],
  ]) {
    const started = process.hrtime.bigint();
    await run().catch(() => null);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(ms < 1000, `${label} took ${ms.toFixed(0)} ms`);
  }
});

test('#784/#787: unterminated collection tags in a 4 MB file-state body are checked in bounded time', async (t) => {
  const body = `<d:multistatus><d:response><d:href>/dav/Docs/notes.md</d:href>${unclosed('<d:collection ')}</d:response></d:multistatus>`;
  const conn = await startRaw(t, body);
  const started = process.hrtime.bigint();
  await fileVersion(conn, 'Docs/notes.md').catch(() => null);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms < 1000, `fileVersion took ${ms.toFixed(0)} ms`);
});

// #833: the S3 ListObjects parse uses the same forward-only scan.
function startRawS3(t, body) {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/xml' }); res.end(body); });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    t.after(() => new Promise((r) => server.close(r)));
    resolve({ kind: 's3', baseUrl: `http://127.0.0.1:${server.address().port}`, bucket: 'b', username: 'ak', secret: 'sk', corpusRoot: 'Cowork' });
  }));
}

test('#833: a 4 MB S3 listing of unclosed tags parses in bounded time', async (t) => {
  const bodies = {
    'unclosed CommonPrefixes': unclosed('<CommonPrefixes><Prefix>Cowork/a/'),
    'unclosed Contents': unclosed('<Contents><Key>Cowork/a.md</Key>'),
    'unclosed Key and Size inside one Contents': `<ListBucketResult><Contents>${unclosed('<Key>')}${unclosed('<Size>')}</Contents></ListBucketResult>`,
    'unclosed Prefix inside one CommonPrefixes': `<ListBucketResult><CommonPrefixes>${unclosed('<Prefix>')}</CommonPrefixes></ListBucketResult>`,
  };
  for (const [label, body] of Object.entries(bodies)) {
    const conn = await startRawS3(t, body);
    const started = process.hrtime.bigint();
    await listFiles(conn, '');
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(ms < 1000, `${label}: listing took ${ms.toFixed(0)} ms`);
  }
});

test('#833: the S3 listing still returns folders and direct-child files with sizes', async (t) => {
  const body = '<?xml version="1.0"?><ListBucketResult><Prefix>Docs/</Prefix>'
    + '<Contents><Key>Docs/</Key><Size>0</Size></Contents>'
    + '<Contents><Key>Docs/notes.md</Key><LastModified>x</LastModified><Size>42</Size></Contents>'
    + '<Contents><Key>Docs/no-size.md</Key></Contents>'
    + '<Contents><Key>Docs/bad-size.md</Key><Size>big</Size></Contents>'
    + '<Contents><Key>Docs/deep/x.md</Key><Size>1</Size></Contents>'
    + '<CommonPrefixes><Prefix>Docs/sub/</Prefix></CommonPrefixes>'
    + '<Contents><Key>Docs/unclosed.md</Key><Size>7</Size></ListBucketResult>';
  const conn = await startRawS3(t, body);
  const listed = await listFiles({ ...conn, corpusRoot: '' }, 'Docs');
  assert.deepEqual(listed.map(({ name, isDir, size }) => [name, isDir, size]).sort((a, b) => a[0].localeCompare(b[0])), [
    ['bad-size.md', false, null], ['no-size.md', false, null], ['notes.md', false, 42], ['sub', true, null],
  ]);
});
