'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { WEB_ADDRESS_READ_OWNER, OWNED_GET_PATHS, ownedRead, refuseOwnedRead } = require('./rust-web-address.cjs');

test('only the three read-only GETs are refused on direct Node requests', () => {
  assert.equal(WEB_ADDRESS_READ_OWNER, 'noevia-web-address-read-rust/1');
  assert.deepEqual(OWNED_GET_PATHS, ['/api/instance', '/.well-known/webauthn', '/api/admin/web-address']);
  for (const path of OWNED_GET_PATHS) {
    assert.equal(ownedRead('GET', path), true);
    const out = {};
    assert.equal(refuseOwnedRead({ method: 'GET' }, {}, path, (_res, status, body) => Object.assign(out, { status, body })), true);
    assert.deepEqual(out, { status: 503, body: { error: 'Web address reads are owned by the Rust front.', code: 'RUST_WEB_ADDRESS_READ_OWNED' } });
    for (const method of ['HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS']) {
      assert.equal(ownedRead(method, path), false);
      assert.equal(refuseOwnedRead({ method }, {}, path, () => { throw Error('must not refuse'); }), false);
    }
  }
  assert.equal(ownedRead('GET', '/api/admin/web-address/remove'), false);
  assert.equal(ownedRead('GET', '/api/instance/'), false);
});

test('Node route factory still handles the old non-GET paths and methods', async () => {
  const { createWebAddressRoutes } = require('./routes/web-address.cjs');
  const replies = [];
  const route = createWebAddressRoutes({
    auth: { instanceId: 'id', origin: 'https://one.test', originSource: 'settings', previousOrigins: [], rpId: 'one.test', removeEarlierOrigin: () => ({ error: 'no earlier address', status: 404 }) },
    json: (_res, status, body) => replies.push({ status, body }),
    readBody: async () => ({ origin: 'https://old.test' }),
    fetchImpl: async () => { throw Error('no network in method oracle'); },
  });
  const admin = { user: { id: 'admin', role: 'admin' } };
  assert.equal(await route({ method: 'HEAD' }, {}, { path: '/api/instance', authn: null }), false);
  assert.equal(await route({ method: 'HEAD' }, {}, { path: '/.well-known/webauthn', authn: null }), false);
  assert.equal(await route({ method: 'HEAD' }, {}, { path: '/api/admin/web-address', authn: admin }), true);
  assert.deepEqual(replies.pop(), { status: 405, body: { error: 'method not allowed' } });
  assert.equal(await route({ method: 'POST' }, {}, { path: '/api/admin/web-address/remove', authn: admin }), true);
  assert.equal(replies.pop().status, 404, 'Node still owns the remove writer');
});
