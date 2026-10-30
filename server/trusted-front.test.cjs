'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { trustedFront, sameSecret } = require('./trusted-front.cjs');

const SECRET = 'f'.repeat(40);
const req = (over = {}) => ({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-noevia-store-token': SECRET }, ...over });

test('only the front\'s own loopback call with the secret is trusted', () => {
  assert.equal(trustedFront(req(), SECRET), true);
  assert.equal(trustedFront(req({ socket: { remoteAddress: '::1' } }), SECRET), true);
  assert.equal(trustedFront(req({ socket: { remoteAddress: '::ffff:127.0.0.1' } }), SECRET), true);
  assert.equal(trustedFront(req({ socket: { remoteAddress: '10.0.0.5' } }), SECRET), false, 'not loopback');
  assert.equal(trustedFront(req({ socket: {} }), SECRET), false);
  assert.equal(trustedFront(req({ headers: {} }), SECRET), false, 'no token');
  assert.equal(trustedFront(req({ headers: { 'x-noevia-store-token': `${SECRET}x` } }), SECRET), false, 'wrong token');
  assert.equal(trustedFront(req({ headers: { 'x-noevia-store-token': SECRET, 'x-forwarded-for': '203.0.113.9' } }), SECRET), false, 'proxied');
  assert.equal(trustedFront(req({ headers: { 'x-noevia-store-token': SECRET, 'x-noevia-client-ip': '203.0.113.9' } }), SECRET), false, 'proxied');
});

test('an empty secret trusts nobody, not even an empty token (the failure of #2218 review H1)', () => {
  assert.equal(sameSecret('', ''), false);
  assert.equal(sameSecret(undefined, ''), false);
  assert.equal(trustedFront(req({ headers: { 'x-noevia-store-token': '' } }), ''), false);
  assert.equal(trustedFront(req(), ''), false);
});

test('the model maintenance lease, the admission lease and the research bridge share this one check', () => {
  for (const f of ['model-maintenance-lease.cjs', 'inference-admission-lease.cjs', 'rust-research-bridge.cjs']) {
    const text = fs.readFileSync(path.join(__dirname, f), 'utf8');
    assert.ok(text.includes("require('./trusted-front.cjs')"), f);
    assert.equal(/const LOOPBACK|function sameSecret/.test(text), false, `${f} carries no copy of the check`);
  }
});
