'use strict';
// The storage routes over a fake network: saving the connection (PUT) with its login check. The
// metadata GET, browsing and the text read are the Rust front's (#1071); so are the folder write,
// the connection test and the Nextcloud sign-in (sbstndalton/noevia#2190: noevia-rs
// tests/storage_integrations.rs). Node refuses all of them always.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createStorageRoutes, STORAGE_PRIVATE_URL_ERROR } = require('./storage.cjs');

function fixture({ storage = { kind: 'local' }, browsable = false, approved = () => true, network = async () => ({ ok: true, status: 200, json: async () => ({}) }), storageLatch } = {}) {
  const sent = [], saved = [], requests = [], storageReads = [];
  const routes = createStorageRoutes({
    json: (res, status, body) => { sent.push({ status, body }); },
    readJson: async (req) => { let s = ''; for await (const c of req) s += c; return s ? JSON.parse(s) : {}; },
    authService: { getStorage: (id, secret) => { storageReads.push([id, secret]); return storage; }, saveStorage: (_id, body) => { saved.push(body); return { ok: true, kind: body.kind }; } },
    endpointApproved: (authn, url) => approved(authn, url),
    fetch: async (url, init) => { requests.push({ url, init }); return network(url, init); },
    storageLatch,
  });
  const call = (method, path, body, userId = 'u1') => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    req.method = method;
    return routes(req, {}, { path, authn: { user: { id: userId, role: 'member' } } });
  };
  return { call, sent, saved, requests, storageReads };
}
test('#1071: the storage metadata GET is always refused before any storage collaborator', async () => {
  const { RUST_STORAGE_READS_REFUSAL } = require('../features.cjs');
  const poison = () => assert.fail('the refused metadata GET touched a collaborator');
  const sent = [];
  const routes = createStorageRoutes({
    json: (_res, status, body) => sent.push({ status, body }), readJson: poison,
    authService: new Proxy({}, { get: poison }), storageClient: new Proxy({}, { get: poison }),
    endpointApproved: poison, fetch: poison, crypto: new Proxy({}, { get: poison }),
  });
  assert.equal(await routes({ method: 'GET' }, {}, { path: '/api/integrations/storage', authn: null }), true);
  assert.deepEqual(sent, [{ status: 503, body: RUST_STORAGE_READS_REFUSAL }]);
});
test('#1071: the refusals leave other methods, adjacent routes and the Node-owned writes alone', async () => {
  const { RUST_STORAGE_READS_REFUSAL, RUST_STORAGE_BROWSE_REFUSAL } = require('../features.cjs');
  const f = fixture({ browsable: true });
  for (const method of [undefined, 'HEAD', 'OPTIONS', 'POST', 'DELETE', 'get']) {
    assert.equal(await f.call(method, '/api/integrations/storage'), false, String(method));
  }
  for (const target of ['/api/integrations/storage/', '/api/integrations/storage-other']) {
    assert.equal(await f.call('GET', target), false);
  }
  for (const [method, path] of [['POST', '/api/integrations/storage/files'], ['GET', '/api/integrations/storage/file']]) {
    assert.equal(await f.call(method, path), false, `${method} ${path}`);
  }
  await f.call('GET', '/api/integrations/storage');
  assert.deepEqual(f.sent.pop(), { status: 503, body: RUST_STORAGE_READS_REFUSAL });
  await f.call('GET', '/api/integrations/storage/files');
  assert.deepEqual(f.sent.pop(), { status: 503, body: RUST_STORAGE_BROWSE_REFUSAL });
  await f.call('POST', '/api/integrations/storage/file', { path: 'synthetic.txt' });
  assert.deepEqual(f.sent.pop(), { status: 503, body: RUST_STORAGE_BROWSE_REFUSAL });
  assert.equal(f.storageReads.length, 0, 'the refused routes never read the saved row');
  await f.call('PUT', '/api/integrations/storage', { kind: 'local' });
  assert.equal(f.saved.length, 1);
  assert.equal(f.storageReads.length, 0, 'the PUT checks the login without reading the saved row');
});
test('saving and the local shortcut keep their shapes; other paths fall through', async () => {
  const f = fixture();
  assert.equal(await f.call('GET', '/api/integrations/storage/nothing'), false);
  assert.equal(await f.call('DELETE', '/api/integrations/storage'), false);
  await f.call('PUT', '/api/integrations/storage', { kind: 'webdav', baseUrl: 'https://cloud.example/dav' });
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'server URL, username, and app password are required' } });
  await f.call('PUT', '/api/integrations/storage', { kind: 'local' });
  assert.deepEqual(f.sent.pop(), { status: 200, body: { ok: true, kind: 'local' } });
  assert.equal(f.requests.length, 0, 'local storage is never probed');
  const refused = fixture({ approved: () => false });
  await refused.call('PUT', '/api/integrations/storage', { kind: 'webdav', baseUrl: 'http://10.0.0.5/dav', username: 'u', secret: 's' });
  assert.deepEqual(refused.sent.pop(), { status: 400, body: { error: STORAGE_PRIVATE_URL_ERROR } });
  assert.equal(refused.saved.length, 0);
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

const HELD = { kind: 'webdav', baseUrl: 'https://cloud.example/dav', username: 'ada', secret: 'synthetic-pw' };
function held(opts = {}) {
  const { createStorageLatch } = require('../storage-latch.cjs');
  const storageLatch = createStorageLatch({ now: () => 0 });
  const f = fixture({ storage: HELD, browsable: true, storageLatch, ...opts });
  storageLatch.note('u1', HELD, { kind: 'login' });
  return Object.assign(f, { isHeld: () => storageLatch.status('u1', HELD) !== null });
}

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

test('#1071: the storage list and the read are always refused before any collaborator', async () => {
  const { RUST_STORAGE_BROWSE_REFUSAL } = require('../features.cjs');
  const poison = () => assert.fail('a refused storage browse touched a collaborator');
  for (const [method, path] of [['GET', '/api/integrations/storage/files'], ['GET', '/api/integrations/storage/files/docs/a'], ['POST', '/api/integrations/storage/file']]) {
    const sent = [];
    const routes = createStorageRoutes({
      json: (_res, status, body) => sent.push({ status, body }), readJson: poison,
      authService: new Proxy({}, { get: poison }), storageClient: new Proxy({}, { get: poison }),
      endpointApproved: poison, fetch: poison, crypto: new Proxy({}, { get: poison }),
    });
    assert.equal(await routes({ method }, {}, { path, authn: { user: { id: 'u1', role: 'member' } } }), true);
    assert.deepEqual(sent, [{ status: 503, body: RUST_STORAGE_BROWSE_REFUSAL }], `${method} ${path}`);
  }
});

test('sbstndalton/noevia#2190: the folder write, the test and the Nextcloud sign-in are refused before any collaborator', async () => {
  const { ROUTE_REFUSAL, OWNED_PATHS } = require('../rust-storage-integrations.cjs');
  const poison = () => assert.fail('a Rust-owned storage route touched a collaborator');
  assert.equal(OWNED_PATHS.length, 5);
  for (const path of OWNED_PATHS) {
    const sent = [];
    const routes = createStorageRoutes({
      json: (_res, status, body) => sent.push({ status, body }), readJson: poison,
      authService: new Proxy({}, { get: poison }), endpointApproved: poison, fetch: poison,
    });
    assert.equal(await routes({ method: 'POST' }, {}, { path, authn: { user: { id: 'u1', role: 'admin' } } }), true, path);
    assert.deepEqual(sent, [{ status: 503, body: ROUTE_REFUSAL }], path);
  }
  const f = fixture();
  for (const [method, path] of [['GET', '/api/integrations/storage/folder'], ['PUT', '/api/integrations/storage/test'], ['POST', '/api/integrations/storage/nextcloud'], ['POST', '/api/integrations/storage/folder/']]) {
    assert.equal(await f.call(method, path), false, `${method} ${path} falls through as before`);
  }
});
