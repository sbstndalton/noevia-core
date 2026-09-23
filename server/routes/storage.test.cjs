'use strict';
// The storage routes over a fake storage client and a fake network: the Nextcloud login flow
// from start to poll (its own bookkeeping, its guards on the URLs the remote hands back), the
// WebDAV probe, browsing and the one folder write. The S3 probe and the origin policy end to
// end are storage-s3.test.cjs and ssrf.test.cjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createStorageRoutes, STORAGE_PRIVATE_URL_ERROR } = require('./storage.cjs');

function fixture({ storage = { kind: 'local' }, browsable = false, approved = () => true, network = async () => ({ ok: true, status: 200, json: async () => ({}) }) } = {}) {
  const sent = [], saved = [], requests = [], storageReads = [];
  const routes = createStorageRoutes({
    json: (res, status, body) => { sent.push({ status, body }); },
    readJson: async (req) => { let s = ''; for await (const c of req) s += c; return s ? JSON.parse(s) : {}; },
    authService: { getStorage: (id, secret) => { storageReads.push([id, secret]); return storage; }, saveStorage: (_id, body) => { saved.push(body); return { ok: true, kind: body.kind }; } },
    storageClient: {
      isBrowsable: () => browsable,
      listFiles: async (_c, dir) => (dir === 'boom' ? (() => { throw new Error('listing failed'); })() : [{ name: 'a.txt', path: `${dir}/a.txt` }]),
      createFolder: async (_c, dir) => { if (dir === 'taken') throw Object.assign(new Error('exists'), { status: 409 }); return { created: dir }; },
      readTextFile: async (_c, file) => ({ path: file, content: 'hi' }),
    },
    endpointApproved: (authn, url) => approved(authn, url),
    fetch: async (url, init) => { requests.push({ url, init }); return network(url, init); },
    crypto: { randomUUID: () => 'flow-1' },
  });
  const call = (method, path, body, userId = 'u1') => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    req.method = method;
    return routes(req, {}, { path, authn: { user: { id: userId, role: 'member' } } });
  };
  return { call, sent, saved, requests, storageReads };
}

test('reading, saving and the local shortcut keep their shapes; other paths fall through', async () => {
  const f = fixture();
  assert.equal(await f.call('GET', '/api/integrations/storage/nothing'), false);
  assert.equal(await f.call('DELETE', '/api/integrations/storage'), false);
  await f.call('GET', '/api/integrations/storage');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { kind: 'local' } });
  await f.call('PUT', '/api/integrations/storage', { kind: 'webdav', baseUrl: 'https://cloud.example/dav' });
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'server URL, username, and app password are required' } });
  await f.call('PUT', '/api/integrations/storage', { kind: 'local' });
  assert.deepEqual(f.sent.pop(), { status: 200, body: { ok: true, kind: 'local' } });
  await f.call('POST', '/api/integrations/storage/test', { kind: 'local' });
  assert.deepEqual(f.sent.pop(), { status: 200, body: { ok: true } });
  assert.equal(f.requests.length, 0, 'local storage is never probed');
  const refused = fixture({ approved: () => false });
  await refused.call('PUT', '/api/integrations/storage', { kind: 'webdav', baseUrl: 'http://10.0.0.5/dav', username: 'u', secret: 's' });
  assert.deepEqual(refused.sent.pop(), { status: 400, body: { error: STORAGE_PRIVATE_URL_ERROR } });
  assert.equal(refused.saved.length, 0);
});

test('browsing, reading and the one folder write need a browsable, approved connection', async () => {
  const none = fixture();
  await none.call('GET', '/api/integrations/storage/files/Docs');
  assert.deepEqual(none.sent.pop(), { status: 400, body: { error: 'no browsable storage connected (local storage needs no browsing — upload files directly)' } });
  await none.call('POST', '/api/integrations/storage/folder', { path: 'x' });
  assert.deepEqual(none.sent.pop(), { status: 400, body: { error: 'no browsable storage connected' } });
  const f = fixture({ storage: { kind: 'webdav', baseUrl: 'https://cloud.example/dav' }, browsable: true });
  await f.call('GET', '/api/integrations/storage/files/Docs%2FNotes');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { entries: [{ name: 'a.txt', path: 'Docs/Notes/a.txt' }] } });
  await f.call('GET', '/api/integrations/storage/files');
  assert.deepEqual(f.sent.pop().body.entries[0].path, '/a.txt');
  await f.call('GET', '/api/integrations/storage/files/boom');
  assert.deepEqual(f.sent.pop(), { status: 502, body: { error: 'listing failed' } });
  await f.call('POST', '/api/integrations/storage/folder', { path: 'taken' });
  assert.deepEqual(f.sent.pop(), { status: 409, body: { error: 'exists' } });
  await f.call('POST', '/api/integrations/storage/folder', { path: 'new' });
  assert.deepEqual(f.sent.pop(), { status: 200, body: { created: 'new' } });
  await f.call('POST', '/api/integrations/storage/file', { path: 'a.txt' });
  assert.deepEqual(f.sent.pop(), { status: 200, body: { path: 'a.txt', content: 'hi' } });
  const demoted = fixture({ storage: { kind: 'webdav', baseUrl: 'http://10.0.0.5/dav' }, browsable: true, approved: () => false });
  await demoted.call('GET', '/api/integrations/storage/files/Docs');
  assert.deepEqual(demoted.sent.pop(), { status: 400, body: { error: STORAGE_PRIVATE_URL_ERROR } }, 'a saved connection is re-checked on every browse');
});

test('the WebDAV probe accepts 207 and reports the status otherwise', async () => {
  const f = fixture({ network: async (url) => ({ ok: false, status: url.includes('Bad') ? 401 : 207 }) });
  await f.call('POST', '/api/integrations/storage/test', { kind: 'webdav', baseUrl: 'https://cloud.example/dav/', username: 'u', secret: 's', corpusRoot: 'Cowork/Diary' });
  assert.deepEqual(f.sent.pop(), { status: 200, body: { ok: true } });
  assert.equal(f.requests[0].url, 'https://cloud.example/dav/Cowork/Diary');
  assert.equal(f.requests[0].init.method, 'PROPFIND');
  assert.equal(f.requests[0].init.headers.Depth, '0');
  assert.equal(f.requests[0].init.redirect, 'error');
  await f.call('POST', '/api/integrations/storage/test', { kind: 'webdav', baseUrl: 'https://cloud.example/Bad', username: 'u', secret: 's' });
  assert.deepEqual(f.sent.pop(), { status: 502, body: { error: 'WebDAV returned 401' } });
  const down = fixture({ network: async () => { throw new Error('ECONNREFUSED'); } });
  await down.call('POST', '/api/integrations/storage/test', { kind: 'webdav', baseUrl: 'https://cloud.example', username: 'u', secret: 's' });
  assert.deepEqual(down.sent.pop(), { status: 502, body: { error: 'ECONNREFUSED' } });
});

test('the Nextcloud login flow starts, polls and saves an app password, guarding every URL', async () => {
  const f = fixture({
    approved: (_authn, url) => !url.startsWith('http://10.'),
    network: async (url) => {
      if (url.endsWith('/index.php/login/v2')) return { ok: true, status: 200, json: async () => ({ login: 'https://cloud.example/login/flow/abc', poll: { endpoint: 'https://cloud.example/login/v2/poll', token: 'ptok' } }) };
      if (url.endsWith('/poll')) return f.pollReply();
      throw new Error(`unexpected ${url}`);
    },
  });
  f.pollReply = () => ({ ok: false, status: 404 });
  await f.call('POST', '/api/integrations/storage/nextcloud/start', { baseUrl: 'http://cloud.example' });
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'HTTPS Nextcloud URL required' } });
  await f.call('POST', '/api/integrations/storage/nextcloud/start', { baseUrl: 'https://cloud.example/' });
  const started = f.sent.pop();
  assert.equal(started.status, 200);
  assert.equal(started.body.flowId, 'flow-1');
  assert.equal(started.body.loginUrl, 'https://cloud.example/login/flow/abc');
  assert.equal(f.requests[0].url, 'https://cloud.example/index.php/login/v2');
  await f.call('POST', '/api/integrations/storage/nextcloud/poll', { flowId: 'flow-1' });
  assert.deepEqual(f.sent.pop(), { status: 202, body: { pending: true } });
  assert.equal(f.requests.at(-1).init.body.toString(), 'token=ptok');
  await f.call('POST', '/api/integrations/storage/nextcloud/poll', { flowId: 'flow-1' }, 'u2');
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'login flow expired' } }, 'a flow belongs to the account that started it');
  f.pollReply = () => ({ ok: true, status: 200, json: async () => ({ server: 'https://cloud.example/', loginName: 'one two', appPassword: 'app-pw' }) });
  await f.call('POST', '/api/integrations/storage/nextcloud/poll', { flowId: 'flow-1', corpusRoot: 'Diary' });
  assert.deepEqual(f.sent.pop(), { status: 200, body: { ok: true, kind: 'nextcloud' } });
  assert.deepEqual(f.saved.pop(), { kind: 'nextcloud', baseUrl: 'https://cloud.example/remote.php/dav/files/one%20two', username: 'one two', secret: 'app-pw', corpusRoot: 'Diary' });
  await f.call('POST', '/api/integrations/storage/nextcloud/poll', { flowId: 'flow-1' });
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'login flow expired' } }, 'a finished flow is gone');
});

test('a Nextcloud that answers with an internal poll endpoint or a plain-http login is refused', async () => {
  const f = fixture({
    approved: (_authn, url) => !url.startsWith('http://10.'),
    network: async () => ({ ok: true, status: 200, json: async () => ({ login: 'https://cloud.example/login', poll: { endpoint: 'http://10.0.0.9/poll', token: 't' } }) }),
  });
  await f.call('POST', '/api/integrations/storage/nextcloud/start', { baseUrl: 'https://cloud.example' });
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'Invalid connection URLs' } });
  const plain = fixture({ network: async () => ({ ok: true, status: 200, json: async () => ({ login: 'http://cloud.example/login', poll: { endpoint: 'https://cloud.example/poll', token: 't' } }) }) });
  await plain.call('POST', '/api/integrations/storage/nextcloud/start', { baseUrl: 'https://cloud.example' });
  assert.deepEqual(plain.sent.pop(), { status: 400, body: { error: 'Invalid connection URLs' } });
  const down = fixture({ network: async () => ({ ok: false, status: 503 }) });
  await down.call('POST', '/api/integrations/storage/nextcloud/start', { baseUrl: 'https://cloud.example' });
  assert.deepEqual(down.sent.pop(), { status: 502, body: { error: 'Nextcloud returned 503' } });
});

test('edited WebDAV fields use only the current account secret without returning or saving it', async () => {
  const storage = { kind: 'webdav', baseUrl: 'https://cloud.example/old', username: 'old', secret: 'synthetic-secret', corpusRoot: 'old' };
  const f = fixture({ storage });
  await f.call('POST', '/api/integrations/storage/test', { kind: 'webdav', baseUrl: 'https://cloud.example/new', username: 'edited', corpusRoot: 'Edited Folder', useSavedSecret: true, userId: 'other' });
  assert.equal(f.requests[0].url, 'https://cloud.example/new/Edited%20Folder');
  assert.equal(f.requests[0].init.headers.Authorization, `Basic ${Buffer.from('edited:synthetic-secret').toString('base64')}`);
  assert.deepEqual(f.sent, [{ status: 200, body: { ok: true } }]);
  assert.deepEqual(f.saved, []);
  assert.equal(storage.username, 'old');
  assert.deepEqual(f.storageReads, [['u1', true]]);
});

test('saved-secret tests reject different origins, types, missing secrets and unapproved targets', async () => {
  const storage = { kind: 'webdav', baseUrl: 'https://cloud.example/old', secret: 'synthetic-secret' };
  for (const patch of [ {baseUrl:'https://evil.example'}, {baseUrl:'http://cloud.example'}, {baseUrl:'https://cloud.example:444'}, {baseUrl:'https://user@cloud.example'}, {kind:'s3'} ]) {
    const f = fixture({storage});
    await f.call('POST', '/api/integrations/storage/test', {...storage, secret:'', useSavedSecret:true, ...patch});
    assert.equal(f.sent[0].status, 400);
    assert.equal(f.requests.length, 0);
  }
  for (const options of [{storage:{...storage,secret:''}}, {storage,approved:()=>false}]) {
    const f=fixture(options);
    await f.call('POST', '/api/integrations/storage/test', {...storage, secret:'', useSavedSecret:true});
    assert.equal(f.sent[0].status,400);
    assert.equal(f.requests.length,0);
  }
});

test('edited S3 endpoint path, bucket and access key are signed with the saved secret', async () => {
  const f=fixture({storage:{kind:'s3',baseUrl:'https://s3.example/old',bucket:'old',username:'old',secret:'synthetic-secret'}});
  await f.call('POST','/api/integrations/storage/test',{kind:'s3',baseUrl:'https://s3.example/new',bucket:'edited',username:'edited-key',useSavedSecret:true});
  assert.equal(f.requests[0].url,'https://s3.example/new/edited?list-type=2&max-keys=1');
  const {signS3Request}=require('../s3-sign.cjs');
  const headers=f.requests[0].init.headers;
  assert.deepEqual(headers, signS3Request('GET', new URL(f.requests[0].url), '', 'edited-key', 'synthetic-secret', {amzDate:headers['x-amz-date']}));
  assert.deepEqual(f.sent,[{status:200,body:{ok:true}}]);
});
