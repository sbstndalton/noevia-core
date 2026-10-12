'use strict';
// The storage routes over a fake storage client and a fake network: the Nextcloud login flow
// from start to poll (its own bookkeeping, its guards on the URLs the remote hands back), the
// WebDAV probe, browsing and the one folder write. The S3 probe and the origin policy end to
// end are storage-s3.test.cjs and ssrf.test.cjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createStorageRoutes, STORAGE_PRIVATE_URL_ERROR, nextcloudServerRoot } = require('./storage.cjs');

function fixture({ storage = { kind: 'local' }, browsable = false, approved = () => true, network = async () => ({ ok: true, status: 200, json: async () => ({}) }), storageReadsOwned, storageLatch } = {}) {
  const sent = [], saved = [], requests = [], storageReads = [];
  const routes = createStorageRoutes({
    json: (res, status, body) => { sent.push({ status, body }); },
    readJson: async (req) => { let s = ''; for await (const c of req) s += c; return s ? JSON.parse(s) : {}; },
    authService: { getStorage: (id, secret) => { storageReads.push([id, secret]); return storage; }, saveStorage: (_id, body) => { saved.push(body); return { ok: true, kind: body.kind }; } },
    storageClient: {
      isBrowsable: () => browsable,
      listFiles: async (_c, dir) => (dir === '..%2Fx' || dir === '../x' ? (() => { throw Object.assign(new Error('Use a relative path inside the storage folder.'), { status: 400 }); })() : dir === 'boom' ? (() => { throw new Error('listing failed'); })() : [{ name: 'a.txt', path: `${dir}/a.txt` }]),
      createFolder: async (_c, dir) => { if (dir === 'taken') throw Object.assign(new Error('exists'), { status: 409 }); return { created: dir }; },
      readTextFile: async (_c, file) => ({ path: file, content: 'hi' }),
    },
    endpointApproved: (authn, url) => approved(authn, url),
    fetch: async (url, init) => { requests.push({ url, init }); return network(url, init); },
    crypto: { randomUUID: () => 'flow-1' },
    storageReadsOwned, storageLatch,
  });
  const call = (method, path, body, userId = 'u1') => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    req.method = method;
    return routes(req, {}, { path, authn: { user: { id: userId, role: 'member' } } });
  };
  return { call, sent, saved, requests, storageReads };
}

test('confirmed storage metadata ownership refuses scoped GET before any storage collaborator', async () => {
  const { RUST_STORAGE_READS_REFUSAL } = require('../features.cjs');
  const poison = () => assert.fail('owned metadata GET touched a collaborator');
  const sent = [];
  const routes = createStorageRoutes({
    json: (_res, status, body) => sent.push({ status, body }), readJson: poison,
    authService: new Proxy({}, { get: poison }), storageClient: new Proxy({}, { get: poison }),
    endpointApproved: poison, fetch: poison, crypto: new Proxy({}, { get: poison }),
    storageReadsOwned: () => true,
  });
  assert.equal(await routes({ method: 'GET' }, {}, { path: '/api/integrations/storage', authn: null }), true);
  assert.deepEqual(sent, [{ status: 503, body: RUST_STORAGE_READS_REFUSAL }]);
});

test('storage ownership preserves default reads, other methods and adjacent routes', async () => {
  const off = fixture();
  await off.call('GET', '/api/integrations/storage');
  assert.deepEqual(off.storageReads, [['u1', undefined]]);
  const owned = fixture({ storageReadsOwned: () => true, browsable: true });
  for (const method of [undefined, 'HEAD', 'OPTIONS', 'POST', 'DELETE', 'get']) {
    assert.equal(await owned.call(method, '/api/integrations/storage'), false);
  }
  for (const target of ['/api/integrations/storage/', '/api/integrations/storage-other']) {
    assert.equal(await owned.call('GET', target), false);
  }
  await owned.call('PUT', '/api/integrations/storage', { kind: 'local' });
  assert.equal(owned.saved.length, 1);
  await owned.call('GET', '/api/integrations/storage/files');
  await owned.call('POST', '/api/integrations/storage/file', { path: 'synthetic.txt' });
  await owned.call('POST', '/api/integrations/storage/folder', { path: 'synthetic' });
  await owned.call('POST', '/api/integrations/storage/test', { kind: 'local' });
  assert.equal(owned.storageReads.length, 3);
  assert.equal(owned.sent.some(reply => reply.status === 503), false);
});

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

// A Nextcloud on a fake network: login/v2 start, the poll, the OCS "who am I" and the DAV check.
function nextcloud(opts = {}) {
  const state = { poll: () => ({ ok: false, status: 404 }), whoami: () => ({ ok: true, status: 200, json: async () => ({ ocs: { data: { id: 'Ada Lovelace' } } }) }), dav: () => ({ ok: false, status: 207 }) };
  const f = fixture({
    approved: (_authn, url) => !url.startsWith('http://10.'),
    network: async (url, init) => {
      if (url.endsWith('/index.php/login/v2')) return { ok: true, status: 200, json: async () => ({ login: 'https://cloud.example/login/flow/abc', poll: { endpoint: 'https://cloud.example/login/v2/poll', token: 'ptok' } }) };
      if (url.endsWith('/login/v2/poll')) return state.poll();
      if (url.includes('/ocs/v2.php/cloud/user')) return state.whoami(init);
      if (url.includes('/ocs/v2.php/core/apppassword')) { if (state.revokeThrows) throw new TypeError('fetch failed'); return { ok: true, status: 200 }; }
      if (url.includes('/remote.php/dav/files/')) return state.dav(url, init);
      throw new Error(`unexpected ${url}`);
    },
    ...opts,
  });
  return Object.assign(f, { state });
}
const granted = (loginName = 'ada@example.com') => () => ({ ok: true, status: 200, json: async () => ({ server: 'https://cloud.example/', loginName, appPassword: 'app-pw' }) });

test('the Nextcloud login flow starts, polls and saves an app password, guarding every URL', async () => {
  const f = nextcloud();
  await f.call('POST', '/api/integrations/storage/nextcloud/start', { baseUrl: 'http://cloud.example' });
  assert.equal(f.sent.pop().body.code, 'nextcloudHttpsRequired');
  await f.call('POST', '/api/integrations/storage/nextcloud/start', { baseUrl: 'https://cloud.example/' });
  const started = f.sent.pop();
  assert.equal(started.status, 200);
  assert.equal(started.body.flowId, 'flow-1');
  assert.equal(started.body.loginUrl, 'https://cloud.example/login/flow/abc');
  assert.equal(f.requests[0].url, 'https://cloud.example/index.php/login/v2');
  assert.equal(f.requests[0].init.headers['User-Agent'], 'Noevia', 'the app password is named after noevia, not "node"');
  await f.call('POST', '/api/integrations/storage/nextcloud/poll', { flowId: 'flow-1' });
  assert.deepEqual(f.sent.pop(), { status: 202, body: { pending: true } });
  assert.equal(f.requests.at(-1).init.body.toString(), 'token=ptok');
  await f.call('POST', '/api/integrations/storage/nextcloud/poll', { flowId: 'flow-1' }, 'u2');
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'login flow expired', code: 'nextcloudFlowExpired' } }, 'a flow belongs to the account that started it');
  f.state.poll = granted('one two');
  f.state.whoami = () => ({ ok: true, status: 200, json: async () => ({ ocs: { data: { id: 'one two' } } }) });
  await f.call('POST', '/api/integrations/storage/nextcloud/poll', { flowId: 'flow-1', corpusRoot: 'Diary' });
  assert.deepEqual(f.sent.pop(), { status: 200, body: { ok: true, kind: 'nextcloud' } });
  assert.deepEqual(f.saved.pop(), { kind: 'nextcloud', baseUrl: 'https://cloud.example/remote.php/dav/files/one%20two', username: 'one two', secret: 'app-pw', corpusRoot: 'Diary' });
  await f.call('POST', '/api/integrations/storage/nextcloud/poll', { flowId: 'flow-1' });
  assert.equal(f.sent.pop().body.code, 'nextcloudFlowExpired', 'a finished flow is gone');
});

test('#1427: an e-mail login is saved under the Nextcloud user id, and the login is checked first', async () => {
  const f = nextcloud();
  await f.call('POST', '/api/integrations/storage/nextcloud/start', { baseUrl: 'https://cloud.example' });
  f.state.poll = granted('ada@example.com');
  await f.call('POST', '/api/integrations/storage/nextcloud/poll', { flowId: 'flow-1', corpusRoot: 'Documents/Diary' });
  assert.equal(f.sent.pop().status, 200);
  const row = f.saved.pop();
  assert.equal(row.baseUrl, 'https://cloud.example/remote.php/dav/files/Ada%20Lovelace', 'the DAV home is the user id, not the login name');
  assert.equal(row.username, 'ada@example.com', 'the app password is bound to the login name it was issued for');
  const who = f.requests.find(r => r.url.includes('/ocs/'));
  assert.equal(who.init.headers['OCS-APIRequest'], 'true');
  assert.equal(who.init.headers.Authorization, `Basic ${Buffer.from('ada@example.com:app-pw').toString('base64')}`);
  const dav = f.requests.find(r => r.url.includes('/remote.php/dav/'));
  assert.equal(dav.url, 'https://cloud.example/remote.php/dav/files/Ada%20Lovelace/');
  assert.equal(dav.init.method, 'PROPFIND');
});

test('#1427: the existing folder is kept when the browser sends none', async () => {
  const f = nextcloud({ storage: { kind: 'webdav', baseUrl: 'http://10.0.0.5/dav', corpusRoot: 'Documents/Important Documents/Diary' } });
  await f.call('POST', '/api/integrations/storage/nextcloud/start', { baseUrl: 'https://cloud.example' });
  f.state.poll = granted();
  await f.call('POST', '/api/integrations/storage/nextcloud/poll', { flowId: 'flow-1' });
  assert.equal(f.saved.pop().corpusRoot, 'Documents/Important Documents/Diary');
  const fresh = nextcloud();
  await fresh.call('POST', '/api/integrations/storage/nextcloud/start', { baseUrl: 'https://cloud.example' });
  fresh.state.poll = granted();
  await fresh.call('POST', '/api/integrations/storage/nextcloud/poll', { flowId: 'flow-1' });
  assert.equal(fresh.saved.pop().corpusRoot, 'Cowork/Diary');
});

test('#1427: a refused or throttled login after sign-in never replaces the saved connection', async () => {
  for (const [dav, code, status] of [[() => ({ ok: false, status: 401 }), 'storageLoginRejected', 502], [() => ({ ok: false, status: 429, headers: new Headers({ 'Retry-After': '120' }) }), 'nextcloudThrottled', 429]]) {
    const f = nextcloud();
    await f.call('POST', '/api/integrations/storage/nextcloud/start', { baseUrl: 'https://cloud.example' });
    f.state.poll = granted(); f.state.dav = dav;
    await f.call('POST', '/api/integrations/storage/nextcloud/poll', { flowId: 'flow-1' });
    const reply = f.sent.pop();
    assert.equal(reply.status, status);
    assert.equal(reply.body.code, code);
    if (code === 'nextcloudThrottled') assert.equal(reply.body.retryAfter, 120);
    assert.equal(f.saved.length, 0);
    assert.doesNotMatch(JSON.stringify(reply), /app-pw/);
  }
  const refused = nextcloud();
  await refused.call('POST', '/api/integrations/storage/nextcloud/start', { baseUrl: 'https://cloud.example' });
  refused.state.poll = granted(); refused.state.whoami = () => ({ ok: false, status: 401 });
  await refused.call('POST', '/api/integrations/storage/nextcloud/poll', { flowId: 'flow-1' });
  assert.equal(refused.sent.pop().body.code, 'storageLoginRejected');
  assert.equal(refused.saved.length, 0);
});

test('#1427: when Nextcloud cannot say who the user is, the login name is used and an unreachable check saves with a warning', async () => {
  const f = nextcloud();
  await f.call('POST', '/api/integrations/storage/nextcloud/start', { baseUrl: 'https://cloud.example' });
  f.state.poll = granted('ada');
  f.state.whoami = () => { throw new TypeError('fetch failed'); };
  f.state.dav = () => { throw Object.assign(new Error('slow'), { name: 'TimeoutError' }); };
  await f.call('POST', '/api/integrations/storage/nextcloud/poll', { flowId: 'flow-1' });
  const reply = f.sent.pop();
  assert.equal(reply.status, 200);
  assert.equal(reply.body.warningCode, 'storageUnverified');
  assert.equal(reply.body.reason, 'timeout');
  assert.match(reply.body.warning, /within 10 seconds/);
  assert.equal(f.saved.pop().baseUrl, 'https://cloud.example/remote.php/dav/files/ada');
});

test('#1427: sign-in starts from the server root whatever URL the field holds', async () => {
  assert.equal(nextcloudServerRoot('https://cloud.example/remote.php/dav/files/ada%20l/Documents'), 'https://cloud.example');
  assert.equal(nextcloudServerRoot('https://cloud.example/nc/index.php/apps/files/?dir=/'), 'https://cloud.example/nc');
  assert.equal(nextcloudServerRoot('https://cloud.example/apps/files'), 'https://cloud.example');
  assert.equal(nextcloudServerRoot(' https://cloud.example:8443/ '), 'https://cloud.example:8443');
  assert.equal(nextcloudServerRoot('https://u:p@cloud.example'), '', 'credentials in the URL are refused');
  assert.equal(nextcloudServerRoot('not a url'), '');
  const f = nextcloud();
  await f.call('POST', '/api/integrations/storage/nextcloud/start', { baseUrl: 'https://cloud.example/remote.php/dav/files/ada' });
  assert.equal(f.sent.pop().status, 200);
  assert.equal(f.requests[0].url, 'https://cloud.example/index.php/login/v2');
  await f.call('POST', '/api/integrations/storage/nextcloud/start', { baseUrl: 'http://10.0.0.5:11000/remote.php/dav/files/ada' });
  assert.equal(f.sent.pop().body.code, 'nextcloudHttpsRequired', 'an internal plain-http WebDAV URL is not a sign-in address');
});

test('a Nextcloud that answers with an internal poll endpoint or a plain-http login is refused', async () => {
  const f = fixture({
    approved: (_authn, url) => !url.startsWith('http://10.'),
    network: async () => ({ ok: true, status: 200, json: async () => ({ login: 'https://cloud.example/login', poll: { endpoint: 'http://10.0.0.9/poll', token: 't' } }) }),
  });
  await f.call('POST', '/api/integrations/storage/nextcloud/start', { baseUrl: 'https://cloud.example' });
  assert.equal(f.sent.pop().body.code, 'nextcloudHttpsRequired');
  const plain = fixture({ network: async () => ({ ok: true, status: 200, json: async () => ({ login: 'http://cloud.example/login', poll: { endpoint: 'https://cloud.example/poll', token: 't' } }) }) });
  await plain.call('POST', '/api/integrations/storage/nextcloud/start', { baseUrl: 'https://cloud.example' });
  assert.deepEqual(plain.sent.pop(), { status: 400, body: { error: 'Invalid connection URLs' } });
});

test('#1427: start says whether Nextcloud was unreachable, missing, throttling or failing', async () => {
  const cases = [
    [() => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); }, 504, 'nextcloudUnreachable'],
    [() => { throw new TypeError('fetch failed'); }, 502, 'nextcloudUnreachable'],
    [() => ({ ok: false, status: 404 }), 502, 'nextcloudNotFound'],
    [() => ({ ok: false, status: 429, headers: new Headers({ 'Retry-After': '30' }) }), 429, 'nextcloudThrottled'],
    [() => ({ ok: false, status: 503 }), 502, 'nextcloudError'],
    [() => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('html'); } }), 502, 'nextcloudNotFound'],
  ];
  for (const [network, status, code] of cases) {
    const f = fixture({ network });
    await f.call('POST', '/api/integrations/storage/nextcloud/start', { baseUrl: 'https://cloud.example' });
    const reply = f.sent.pop();
    assert.equal(reply.status, status, code);
    assert.equal(reply.body.code, code);
    assert.match(reply.body.error, /cloud\.example|Nextcloud returned/);
  }
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

test('browsing a refused path answers 400, not 502 (#984)', async () => {
  const f = fixture({ storage: { kind: 'webdav', baseUrl: 'https://cloud.example/dav' }, browsable: true });
  await f.call('GET', '/api/integrations/storage/files/..%2Fx');
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'Use a relative path inside the storage folder.' } });
  await f.call('GET', '/api/integrations/storage/files/boom');
  assert.equal(f.sent.pop().status, 502);
});

test('#1427: a manual save says when the server was throttling or too slow to check the login', async () => {
  const body = { kind: 'webdav', baseUrl: 'https://cloud.example/remote.php/dav/files/ada', username: 'ada', secret: 'synthetic-secret' };
  const throttled = fixture({ network: async () => ({ ok: false, status: 429, headers: new Headers({ 'Retry-After': '60' }), body: null }) });
  await throttled.call('PUT', '/api/integrations/storage', body);
  const t = throttled.sent.pop();
  assert.equal(t.status, 200);
  assert.equal(t.body.warningCode, 'storageThrottled');
  assert.equal(t.body.retryAfter, 60);
  assert.match(t.body.warning, /throttling/);
  const slow = fixture({ network: async () => { throw Object.assign(new Error('slow'), { name: 'TimeoutError' }); } });
  await slow.call('PUT', '/api/integrations/storage', body);
  const s = slow.sent.pop();
  assert.equal(s.body.warningCode, 'storageUnverified');
  assert.equal(s.body.reason, 'timeout');
  assert.match(s.body.warning, /could not be reached within 10 seconds/);
  assert.doesNotMatch(JSON.stringify([t, s]), /synthetic-secret/);
});

// #1432 / #1433: the poll token and the app password only go over https to the origin sign-in
// started at; an issued app password that is not saved is revoked; Cancel ends the flow server-side.
const revocations = (f) => f.requests.filter(r => r.init?.method === 'DELETE' && r.url.endsWith('/ocs/v2.php/core/apppassword'));

test('#1432: start refuses a poll endpoint that is plain http or on another origin, and never contacts it', async () => {
  for (const [endpoint, code] of [['http://cloud.example/login/v2/poll', 'nextcloudHttpsRequired'], ['https://other.example/login/v2/poll', 'nextcloudOriginMismatch']]) {
    const f = fixture({ network: async () => ({ ok: true, status: 200, json: async () => ({ login: 'https://cloud.example/login/flow/x', poll: { endpoint, token: 'ptok' } }) }) });
    await f.call('POST', '/api/integrations/storage/nextcloud/start', { baseUrl: 'https://cloud.example' });
    const reply = f.sent.pop();
    assert.equal(reply.status, 400);
    assert.equal(reply.body.code, code);
    if (code === 'nextcloudOriginMismatch') assert.match(reply.body.error, /overwritehost.*overwrite\.cli\.url/);
    await f.call('POST', '/api/integrations/storage/nextcloud/poll', { flowId: 'flow-1' });
    assert.equal(f.sent.pop().body.code, 'nextcloudFlowExpired', 'no flow was stored');
    assert.deepEqual(f.requests.map(r => r.url), ['https://cloud.example/index.php/login/v2'], 'only the https start request went out');
  }
});

test('#1432: an issued app password for a plain-http or other-origin server is refused and never sent anywhere', async () => {
  for (const [server, code] of [['http://cloud.example/', 'nextcloudHttpsRequired'], ['https://evil.example/', 'nextcloudOriginMismatch']]) {
    const f = nextcloud();
    await f.call('POST', '/api/integrations/storage/nextcloud/start', { baseUrl: 'https://cloud.example' });
    f.state.poll = () => ({ ok: true, status: 200, json: async () => ({ server, loginName: 'ada', appPassword: 'app-pw' }) });
    const before = f.requests.length;
    await f.call('POST', '/api/integrations/storage/nextcloud/poll', { flowId: 'flow-1' });
    const reply = f.sent.pop();
    assert.equal(reply.body.code, code);
    if (code === 'nextcloudOriginMismatch') assert.match(reply.body.error, /overwritehost/);
    assert.equal(f.saved.length, 0);
    const after = f.requests.slice(before).map(r => r.url);
    assert.deepEqual(after, ['https://cloud.example/login/v2/poll'], 'nothing but the poll itself: no OCS, DAV or revoke request');
    assert.doesNotMatch(JSON.stringify(reply), /app-pw/);
  }
});

test('#1433: every failure after the app password is issued revokes it on the trusted server', async () => {
  const cases = [
    ['OCS 401', (f) => { f.state.whoami = () => ({ ok: false, status: 401 }); }, 'storageLoginRejected'],
    ['OCS 429', (f) => { f.state.whoami = () => ({ ok: false, status: 429, headers: new Headers() }); }, 'nextcloudThrottled'],
    ['DAV 401', (f) => { f.state.dav = () => ({ ok: false, status: 401 }); }, 'storageLoginRejected'],
    ['DAV 429', (f) => { f.state.dav = () => ({ ok: false, status: 429, headers: new Headers() }); }, 'nextcloudThrottled'],
  ];
  for (const [name, arrange, code] of cases) {
    const f = nextcloud();
    await f.call('POST', '/api/integrations/storage/nextcloud/start', { baseUrl: 'https://cloud.example' });
    f.state.poll = granted('ada@example.com'); arrange(f);
    await f.call('POST', '/api/integrations/storage/nextcloud/poll', { flowId: 'flow-1' });
    assert.equal(f.sent.pop().body.code, code, name);
    assert.equal(f.saved.length, 0, name);
    const revoked = revocations(f);
    assert.equal(revoked.length, 1, `${name} revokes once`);
    assert.equal(revoked[0].url, 'https://cloud.example/ocs/v2.php/core/apppassword');
    assert.equal(revoked[0].init.headers.Authorization, `Basic ${Buffer.from('ada@example.com:app-pw').toString('base64')}`);
    assert.equal(revoked[0].init.headers['OCS-APIRequest'], 'true');
    assert.equal(revoked[0].init.redirect, 'error');
  }
  const blocked = nextcloud({ approved: (_a, url) => !url.includes('/remote.php/dav/') && !url.startsWith('http://10.') });
  await blocked.call('POST', '/api/integrations/storage/nextcloud/start', { baseUrl: 'https://cloud.example' });
  blocked.state.poll = granted();
  await blocked.call('POST', '/api/integrations/storage/nextcloud/poll', { flowId: 'flow-1' });
  assert.equal(blocked.sent.pop().body.error, STORAGE_PRIVATE_URL_ERROR);
  assert.equal(revocations(blocked).length, 1, 'an unapproved DAV home revokes the password');
  const ok = nextcloud();
  await ok.call('POST', '/api/integrations/storage/nextcloud/start', { baseUrl: 'https://cloud.example' });
  ok.state.poll = granted();
  await ok.call('POST', '/api/integrations/storage/nextcloud/poll', { flowId: 'flow-1' });
  assert.equal(ok.saved.length, 1);
  assert.equal(revocations(ok).length, 0, 'a saved app password is kept');
});

test('#1433: a failed revoke never changes the answer', async () => {
  const f = nextcloud();
  await f.call('POST', '/api/integrations/storage/nextcloud/start', { baseUrl: 'https://cloud.example' });
  f.state.poll = granted(); f.state.dav = () => ({ ok: false, status: 401 }); f.state.revokeThrows = true;
  await f.call('POST', '/api/integrations/storage/nextcloud/poll', { flowId: 'flow-1' });
  const reply = f.sent.pop();
  assert.equal(reply.status, 502);
  assert.equal(reply.body.code, 'storageLoginRejected');
  assert.equal(revocations(f).length, 1, 'the revoke was attempted');
  assert.equal(f.saved.length, 0);
});

test('#1433: cancel ends the flow for its own account only, and a cancel during a poll revokes instead of saving', async () => {
  const f = nextcloud();
  await f.call('POST', '/api/integrations/storage/nextcloud/start', { baseUrl: 'https://cloud.example' });
  await f.call('POST', '/api/integrations/storage/nextcloud/cancel', { flowId: 'flow-1' }, 'u2');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { cancelled: false } }, 'another account cannot cancel it');
  await f.call('POST', '/api/integrations/storage/nextcloud/poll', { flowId: 'flow-1' });
  assert.deepEqual(f.sent.pop(), { status: 202, body: { pending: true } });
  await f.call('POST', '/api/integrations/storage/nextcloud/cancel', { flowId: 'flow-1' });
  assert.deepEqual(f.sent.pop(), { status: 200, body: { cancelled: true } });
  await f.call('POST', '/api/integrations/storage/nextcloud/poll', { flowId: 'flow-1' });
  assert.equal(f.sent.pop().body.code, 'nextcloudFlowExpired');

  const race = nextcloud();
  await race.call('POST', '/api/integrations/storage/nextcloud/start', { baseUrl: 'https://cloud.example' });
  race.state.poll = () => {
    // The person presses Cancel while Nextcloud is handing the password over.
    const reply = granted('ada')();
    return { ...reply, json: async () => { await race.call('POST', '/api/integrations/storage/nextcloud/cancel', { flowId: 'flow-1' }); race.sent.pop(); return reply.json(); } };
  };
  await race.call('POST', '/api/integrations/storage/nextcloud/poll', { flowId: 'flow-1' });
  const reply = race.sent.pop();
  assert.equal(reply.status, 409);
  assert.equal(reply.body.code, 'nextcloudFlowCancelled');
  assert.equal(race.saved.length, 0);
  assert.equal(revocations(race).length, 1);
});

// #1589: an explicit storage call that works ends the hold on automatic calls; one that fails, or that tried
// other credentials than the saved ones, does not.
const HELD = { kind: 'webdav', baseUrl: 'https://cloud.example/dav', username: 'ada', secret: 'synthetic-pw' };
function held(opts = {}) {
  const { createStorageLatch } = require('../storage-latch.cjs');
  const storageLatch = createStorageLatch({ now: () => 0 });
  const f = fixture({ storage: HELD, browsable: true, storageLatch, ...opts });
  storageLatch.note('u1', HELD, { kind: 'login' });
  return Object.assign(f, { isHeld: () => storageLatch.status('u1', HELD) !== null });
}

test('#1589: browsing, reading and creating a folder over the saved login end the hold when they work', async () => {
  for (const [method, path, body] of [['GET', '/api/integrations/storage/files/Docs'], ['POST', '/api/integrations/storage/file', { path: 'a.txt' }], ['POST', '/api/integrations/storage/folder', { path: 'new' }]]) {
    const f = held();
    assert.equal(f.isHeld(), true);
    await f.call(method, path, body);
    assert.equal(f.sent.pop().status, 200, path);
    assert.equal(f.isHeld(), false, path);
  }
  const failing = held();
  await failing.call('GET', '/api/integrations/storage/files/boom');
  assert.equal(failing.sent.pop().status, 502);
  assert.equal(failing.isHeld(), true, 'a failed call proves nothing');
});

test('#1589: Test connection with the saved login ends the hold; a failed test or other credentials do not', async () => {
  const ok = held({ network: async () => ({ ok: true, status: 207 }) });
  await ok.call('POST', '/api/integrations/storage/test', { kind: 'webdav', baseUrl: HELD.baseUrl, username: HELD.username, secret: HELD.secret });
  assert.equal(ok.sent.pop().status, 200);
  assert.equal(ok.isHeld(), false);
  const savedSecret = held({ network: async () => ({ ok: true, status: 207 }) });
  await savedSecret.call('POST', '/api/integrations/storage/test', { kind: 'webdav', baseUrl: HELD.baseUrl, username: HELD.username, useSavedSecret: true });
  assert.equal(savedSecret.sent.pop().status, 200);
  assert.equal(savedSecret.isHeld(), false, 'the saved secret was the one tested');
  const other = held({ network: async () => ({ ok: true, status: 207 }) });
  await other.call('POST', '/api/integrations/storage/test', { kind: 'webdav', baseUrl: HELD.baseUrl, username: HELD.username, secret: 'another-pw' });
  assert.equal(other.sent.pop().status, 200);
  assert.equal(other.isHeld(), true, 'a different password says nothing about the saved one');
  const refused = held({ network: async () => ({ ok: false, status: 401 }) });
  await refused.call('POST', '/api/integrations/storage/test', { kind: 'webdav', baseUrl: HELD.baseUrl, username: HELD.username, secret: HELD.secret });
  assert.equal(refused.sent.pop().status, 502);
  assert.equal(refused.isHeld(), true);
});

test('#1589: saving a login the server accepted ends the hold, and an unchecked save does not', async () => {
  const accepted = held({ network: async () => ({ ok: true, status: 207 }) });
  await accepted.call('PUT', '/api/integrations/storage', { kind: 'webdav', baseUrl: HELD.baseUrl, username: HELD.username, secret: HELD.secret });
  assert.equal(accepted.sent.pop().status, 200);
  assert.equal(accepted.isHeld(), false);
  const unchecked = held({ network: async () => { throw new TypeError('fetch failed'); } });
  await unchecked.call('PUT', '/api/integrations/storage', { kind: 'webdav', baseUrl: HELD.baseUrl, username: HELD.username, secret: HELD.secret });
  assert.equal(unchecked.sent.pop().body.warningCode, 'storageUnverified');
  assert.equal(unchecked.isHeld(), true, 'the server was not reached, so the login is still unproven');
});
