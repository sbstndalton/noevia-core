'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  WEB_ADDRESS_READ_OWNER, WEB_ADDRESS_WRITE_OWNER, OWNED_GET_PATHS, OWNED_POST_PATHS,
  ownedRead, ownedWrite, refuseOwnedRead, refuseOwnedWrite,
} = require('./rust-web-address.cjs');

test('exact three GETs and two POSTs are refused on direct Node requests', () => {
  assert.equal(WEB_ADDRESS_READ_OWNER, 'noevia-web-address-read-rust/1');
  assert.equal(WEB_ADDRESS_WRITE_OWNER, 'noevia-web-address-write-rust/1');
  assert.deepEqual(OWNED_GET_PATHS, ['/api/instance', '/.well-known/webauthn', '/api/admin/web-address']);
  assert.deepEqual(OWNED_POST_PATHS, ['/api/admin/web-address', '/api/admin/web-address/remove']);
  for (const path of OWNED_GET_PATHS) {
    assert.equal(ownedRead('GET', path), true);
    const out = {};
    assert.equal(refuseOwnedRead({ method: 'GET' }, {}, path, (_res, status, body) => Object.assign(out, { status, body })), true);
    assert.deepEqual(out, { status: 503, body: { error: 'Web address reads are owned by the Rust front.', code: 'RUST_WEB_ADDRESS_READ_OWNED' } });
    for (const method of ['HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS']) assert.equal(ownedRead(method, path), false);
  }
  for (const path of OWNED_POST_PATHS) {
    assert.equal(ownedWrite('POST', path), true);
    const out = {};
    assert.equal(refuseOwnedWrite({ method: 'POST' }, {}, path, (_res, status, body) => Object.assign(out, { status, body })), true);
    assert.deepEqual(out, { status: 503, body: { error: 'Web address changes are owned by the Rust front.', code: 'RUST_WEB_ADDRESS_WRITE_OWNED' } });
    for (const method of ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']) assert.equal(ownedWrite(method, path), false);
  }
  assert.equal(ownedWrite('POST', '/api/instance'), false);
  assert.equal(ownedWrite('POST', '/api/admin/web-address/remove/'), false);
});
