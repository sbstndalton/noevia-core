'use strict';
// #655: an in-place edit that cannot be confirmed says why, and never retries a conditional PUT.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const storageClient = require('../../server/storage-client.cjs');
const { createProjectStore } = require('../../server/projects.cjs');

const DAV = { kind: 'webdav', baseUrl: 'https://dav.test/remote.php/dav/files/u', username: 'u', secret: 's' };
const propfind = (etag, folder) => `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/x</d:href><d:propstat><d:prop><d:resourcetype>${folder ? '<d:collection/>' : ''}</d:resourcetype><d:getetag>${etag}</d:getetag></d:prop></d:propstat></d:response></d:multistatus>`;
const sha = (text) => crypto.createHash('sha256').update(Buffer.from(text)).digest('hex');
const STORED = 'Projects/p1/Text/notes.md';

async function withFetch(handler, fn) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, init = {}) => { calls.push({ url: String(url), method: init.method || 'GET' }); return handler(String(url), init, calls); };
  try { return await fn(calls); } finally { global.fetch = original; }
}
const reply = (status, body = '') => new Response(body, { status });

test('a conditional PUT is not retried after a connection failure and reports an unknown outcome', async () => {
  await withFetch(() => { throw new TypeError('fetch failed'); }, async (calls) => {
    await assert.rejects(storageClient.writeFile(DAV, STORED, Buffer.from('x'), { ifMatch: 'abc' }), (err) => err.code === 'unknown' && err.status === 502);
    assert.equal(calls.length, 1, 'exactly one PUT attempt');
  });
});

test('a conditional PUT that times out also reports an unknown outcome', async () => {
  await withFetch(() => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); }, async (calls) => {
    await assert.rejects(storageClient.writeFile(DAV, STORED, Buffer.from('x'), { ifMatch: 'abc' }), (err) => err.code === 'unknown');
    assert.equal(calls.length, 1);
  });
});

test('an unconditional PUT still gets its one transport retry, and a conditional 412 is still "changed"', async () => {
  let n = 0;
  await withFetch(() => (++n === 1 ? Promise.reject(new TypeError('fetch failed')) : reply(201)), async (calls) => {
    await storageClient.writeFile(DAV, STORED, Buffer.from('x'));
    assert.equal(calls.length, 2);
  });
  await withFetch(() => reply(412), async () => {
    await assert.rejects(storageClient.writeFile(DAV, STORED, Buffer.from('x'), { ifMatch: 'abc' }), (err) => err.code === 'changed');
  });
});

function makeStore({ connection, handler }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-655-'));
  const project = { id: 'p1', projectFolder: 'Projects/p1', files: [{ name: STORED, content: 'hello', attachment: { id: sha('hello'), state: 'ready' } }] };
  const PROJECTS = [project];
  const workspace = { userId: 'u1', dir, revoked: false, assertActive() {}, saveProjects() {}, assetDir: (id) => path.join(dir, 'assets', id), projects: PROJECTS };
  const store = createProjectStore({
    fs, path, PROJECTS, FREE_CHATS: [], currentWorkspace: () => workspace, storageClient,
    rag: { deleteProjectFile() {}, indexProjectFile() {}, index() {} },
    authService: { getStorage: () => connection }, documentSources: { prune() {}, directory: () => dir },
    PROJECT_ROOT_FOLDER: 'Projects', projectSweep: { afterDelete: async () => {} },
  });
  return { store, project, run: () => store.writeProjectTextFile(project, 'notes.md', 'hello edited', { expectName: STORED, expectContent: 'hello', expectAttachment: sha('hello') }) };
}

// A fake storage server: PROPFIND -> version, GET -> bytes, PUT -> as configured.
const server = ({ propfindReply, getReply, putReply }) => (url, init) => {
  if (init.method === 'PROPFIND') return propfindReply();
  if (init.method === 'PUT') return putReply ? putReply() : reply(204);
  if (init.method === 'MKCOL') return reply(201);
  return getReply ? getReply() : reply(200, 'hello');
};

async function refusal(conn, handler, expected, notExpected) {
  const { run } = makeStore({ connection: conn });
  await withFetch(handler, async (calls) => {
    await assert.rejects(run(), (err) => {
      assert.match(err.message, expected);
      if (notExpected) assert.doesNotMatch(err.message, notExpected);
      return true;
    });
    assert.ok(!calls.some((c) => c.method === 'PUT'), 'nothing is written');
  });
}
const CHANGED = /changed in storage/;

test('S3 storage: in-place edits are not supported, not "changed in storage"', async () => {
  await refusal({ kind: 's3', baseUrl: 'https://s3.test', bucket: 'b', username: 'a', secret: 'b' }, () => reply(200), /not supported on this storage type/, CHANGED);
});

test('401 and 403 say to reconnect storage', async () => {
  for (const status of [401, 403]) {
    await refusal(DAV, server({ propfindReply: () => reply(status) }), /Reconnect storage/, CHANGED);
  }
  await refusal(DAV, server({ propfindReply: () => reply(207, propfind('"e1"')), getReply: () => reply(403) }), /Reconnect storage/, CHANGED);
});

test('5xx, a timeout and a dropped connection say storage is unavailable', async () => {
  await refusal(DAV, server({ propfindReply: () => reply(503) }), /Storage is unavailable/, CHANGED);
  await refusal(DAV, server({ propfindReply: () => reply(207, propfind('"e1"')), getReply: () => reply(500) }), /Storage is unavailable/, CHANGED);
  await refusal(DAV, () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); }, /Storage is unavailable/, CHANGED);
  await refusal(DAV, () => Promise.reject(new TypeError('fetch failed')), /Storage is unavailable/, CHANGED);
});

test('a folder path says it is a folder', async () => {
  await refusal(DAV, server({ propfindReply: () => reply(207, propfind('"e1"', true)) }), /is a folder in storage/, CHANGED);
});

test('404 and a hash mismatch still say the file changed in storage', async () => {
  await refusal(DAV, server({ propfindReply: () => reply(404) }), CHANGED);
  await refusal(DAV, server({ propfindReply: () => reply(207, propfind('"e1"')), getReply: () => reply(200, 'someone else edited this') }), CHANGED);
  await refusal(DAV, server({ propfindReply: () => reply(207, propfind('"e1"')), getReply: () => reply(404) }), CHANGED);
});

test('a connection failure on the conditional PUT reports an unknown outcome, once', async () => {
  const { run } = makeStore({ connection: DAV });
  const handler = server({ propfindReply: () => reply(207, propfind('"e1"')), putReply: () => { throw new TypeError('fetch failed'); } });
  await withFetch(handler, async (calls) => {
    await assert.rejects(run(), (err) => /Outcome unknown: sync this project's Sources to check/.test(err.message) && !CHANGED.test(err.message));
    assert.equal(calls.filter((c) => c.method === 'PUT').length, 1);
  });
});
