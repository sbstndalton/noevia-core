'use strict';
// What is left of the storage routes: refusals. The metadata GET, browsing and the text read are the
// Rust front's (#1071); so are the folder write, the connection test, the Nextcloud sign-in and,
// since sbstndalton/noevia#2190 round 4, the save (noevia-rs tests/storage_integrations.rs asserts
// their behaviour). Node refuses all of them, before touching any collaborator.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStorageRoutes, STORAGE_PRIVATE_URL_ERROR } = require('./storage.cjs');

const poison = () => assert.fail('a refused storage route touched a collaborator');
function fixture() {
  const sent = [];
  const routes = createStorageRoutes({ json: (res, status, body) => { sent.push({ status, body }); } });
  const call = (method, path) => routes({ method }, {}, { path, authn: { user: { id: 'u1', role: 'member' } } });
  return { call, sent };
}
test('#1071: the storage metadata GET is always refused before any storage collaborator', async () => {
  const { RUST_STORAGE_READS_REFUSAL } = require('../features.cjs');
    const sent = [];
  const routes = createStorageRoutes({
    json: (_res, status, body) => sent.push({ status, body }), readJson: poison,
    authService: new Proxy({}, { get: poison }), storageClient: new Proxy({}, { get: poison }),
    endpointApproved: poison, fetch: poison, crypto: new Proxy({}, { get: poison }),
  });
  assert.equal(await routes({ method: 'GET' }, {}, { path: '/api/integrations/storage', authn: null }), true);
  assert.deepEqual(sent, [{ status: 503, body: RUST_STORAGE_READS_REFUSAL }]);
});
test('#1071/#2190: the refusals leave other methods and adjacent routes alone', async () => {
  const { RUST_STORAGE_READS_REFUSAL, RUST_STORAGE_BROWSE_REFUSAL } = require('../features.cjs');
  const { ROUTE_REFUSAL } = require('../rust-storage-connection.cjs');
  const f = fixture();
  for (const method of [undefined, 'HEAD', 'OPTIONS', 'POST', 'DELETE', 'get', 'put']) {
    assert.equal(await f.call(method, '/api/integrations/storage'), false, String(method));
  }
  for (const target of ['/api/integrations/storage/', '/api/integrations/storage-other']) {
    assert.equal(await f.call('GET', target), false);
    assert.equal(await f.call('PUT', target), false);
  }
  for (const [method, path] of [['POST', '/api/integrations/storage/files'], ['GET', '/api/integrations/storage/file'], ['GET', '/api/integrations/storage/nothing']]) {
    assert.equal(await f.call(method, path), false, `${method} ${path}`);
  }
  await f.call('GET', '/api/integrations/storage');
  assert.deepEqual(f.sent.pop(), { status: 503, body: RUST_STORAGE_READS_REFUSAL });
  await f.call('GET', '/api/integrations/storage/files');
  assert.deepEqual(f.sent.pop(), { status: 503, body: RUST_STORAGE_BROWSE_REFUSAL });
  await f.call('POST', '/api/integrations/storage/file');
  assert.deepEqual(f.sent.pop(), { status: 503, body: RUST_STORAGE_BROWSE_REFUSAL });
  await f.call('PUT', '/api/integrations/storage');
  assert.deepEqual(f.sent.pop(), { status: 503, body: ROUTE_REFUSAL });
  assert.equal(f.sent.length, 0);
});

test('sbstndalton/noevia#2190 round 4: the save is refused before any collaborator', async () => {
  const { ROUTE_REFUSAL } = require('../rust-storage-connection.cjs');
  const sent = [];
  // Only json is wired now; the old collaborators are passed poisoned to show none is touched.
  const routes = createStorageRoutes({
    json: (_res, status, body) => sent.push({ status, body }), readJson: poison,
    authService: new Proxy({}, { get: poison }), endpointApproved: poison, fetch: poison,
  });
  assert.equal(await routes({ method: 'PUT' }, {}, { path: '/api/integrations/storage', authn: { user: { id: 'u1', role: 'admin' } } }), true);
  assert.deepEqual(sent, [{ status: 503, body: { error: 'The storage connection is owned by the Rust front.', code: 'RUST_STORAGE_CONNECTION_OWNED' } }]);
  assert.equal(ROUTE_REFUSAL.code, 'RUST_STORAGE_CONNECTION_OWNED');
  // The member-origin text is still exported (the front answers it with the same words).
  assert.match(STORAGE_PRIVATE_URL_ERROR, /MEMBER_OUTBOUND_ORIGINS/);
});

test('#1071: the storage list and the read are always refused before any collaborator', async () => {
  const { RUST_STORAGE_BROWSE_REFUSAL } = require('../features.cjs');
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
