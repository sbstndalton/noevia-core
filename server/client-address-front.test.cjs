'use strict';

// #1245: the Rust front answers for the client address in X-Noevia-Client-Ip. Node believes it only
// from a loopback peer with NOEVIA_FRONT=rust; otherwise the socket (or TRUST_PROXY's XFF) decides,
// exactly as before. Synthetic addresses only.

const test = require('node:test');
const assert = require('node:assert/strict');

const { clientAddress } = require('./auth.cjs');

function fakeReq(headers, remoteAddress) {
  return { headers, socket: { remoteAddress } };
}

test('with NOEVIA_FRONT=rust the front\'s address is used from a loopback peer, with or without TRUST_PROXY', () => {
  const req = fakeReq({ 'x-noevia-client-ip': '192.168.1.20' }, '127.0.0.1');
  assert.equal(clientAddress(req, false, { front: true }), '192.168.1.20');
  assert.equal(clientAddress(req, true, { front: true }), '192.168.1.20');
  // Every loopback form of the front's peer is accepted.
  for (const peer of ['::1', '::ffff:127.0.0.1', '127.10.0.1']) {
    assert.equal(clientAddress(fakeReq({ 'x-noevia-client-ip': '10.1.2.3' }, peer), false, { front: true }), '10.1.2.3', peer);
  }
  // IPv6 clients are accepted as they are.
  assert.equal(clientAddress(fakeReq({ 'x-noevia-client-ip': '2001:db8::5' }, '127.0.0.1'), false, { front: true }), '2001:db8::5');
});

test('the front\'s header is ignored from any peer that is not loopback (a direct client cannot choose its address)', () => {
  for (const peer of ['10.0.0.9', '192.168.1.20', '::ffff:10.0.0.9', '2001:db8::9']) {
    const req = fakeReq({ 'x-noevia-client-ip': '6.6.6.6' }, peer);
    assert.equal(clientAddress(req, false, { front: true }), peer, peer);
    assert.equal(clientAddress(req, true, { front: true }), peer, peer);
  }
});

test('without NOEVIA_FRONT=rust the header is ignored, even from loopback (the tunnel can reach Node directly)', () => {
  const req = fakeReq({ 'x-noevia-client-ip': '6.6.6.6' }, '127.0.0.1');
  assert.equal(clientAddress(req, false, { front: false }), '127.0.0.1');
  assert.equal(clientAddress(req, false, { front: false }), '127.0.0.1');
  const saved = process.env.NOEVIA_FRONT, savedConfirm = process.env.NOEVIA_FRONT_CLIENT_IP;
  try {
    process.env.NOEVIA_FRONT = 'node';
    assert.equal(clientAddress(req), '127.0.0.1');
    process.env.NOEVIA_FRONT = 'RUST';
    assert.equal(clientAddress(req), '127.0.0.1', 'the switch is exactly rust');
    process.env.NOEVIA_FRONT = 'rust';
    process.env.NOEVIA_FRONT_CLIENT_IP = '1';
    assert.equal(clientAddress(req), '6.6.6.6', 'read from the environment when no option is given');
  } finally {
    if (saved === undefined) delete process.env.NOEVIA_FRONT; else process.env.NOEVIA_FRONT = saved;
    if (savedConfirm === undefined) delete process.env.NOEVIA_FRONT_CLIENT_IP; else process.env.NOEVIA_FRONT_CLIENT_IP = savedConfirm;
  }
});

test('NOEVIA_FRONT=rust alone is not enough: the supervisor must confirm the front strips client copies (#1578)', () => {
  const req = fakeReq({ 'x-noevia-client-ip': '6.6.6.6' }, '127.0.0.1');
  const saved = { front: process.env.NOEVIA_FRONT, confirm: process.env.NOEVIA_FRONT_CLIENT_IP };
  try {
    process.env.NOEVIA_FRONT = 'rust';
    delete process.env.NOEVIA_FRONT_CLIENT_IP;
    assert.equal(clientAddress(req), '127.0.0.1', 'a front that predates the strip: header ignored');
    assert.equal(clientAddress(req, true), '127.0.0.1');
    for (const v of ['', '0', 'true', 'yes']) {
      process.env.NOEVIA_FRONT_CLIENT_IP = v;
      assert.equal(clientAddress(req), '127.0.0.1', `confirmation is exactly 1, not ${JSON.stringify(v)}`);
    }
    // With a trusted proxy the unconfirmed header still cannot override the XFF rule.
    delete process.env.NOEVIA_FRONT_CLIENT_IP;
    assert.equal(clientAddress(fakeReq({ 'x-noevia-client-ip': '6.6.6.6', 'x-forwarded-for': '203.0.113.7' }, '127.0.0.1'), true), '203.0.113.7');
    process.env.NOEVIA_FRONT_CLIENT_IP = '1';
    assert.equal(clientAddress(req), '6.6.6.6');
    // The confirmation without NOEVIA_FRONT=rust does nothing either.
    process.env.NOEVIA_FRONT = 'node';
    assert.equal(clientAddress(req), '127.0.0.1');
  } finally {
    if (saved.front === undefined) delete process.env.NOEVIA_FRONT; else process.env.NOEVIA_FRONT = saved.front;
    if (saved.confirm === undefined) delete process.env.NOEVIA_FRONT_CLIENT_IP; else process.env.NOEVIA_FRONT_CLIENT_IP = saved.confirm;
  }
});

test('a malformed or repeated front header falls back to the old answer', () => {
  const socketOnly = { front: true };
  assert.equal(clientAddress(fakeReq({ 'x-noevia-client-ip': 'not-an-ip' }, '127.0.0.1'), false, socketOnly), '127.0.0.1');
  assert.equal(clientAddress(fakeReq({ 'x-noevia-client-ip': '' }, '127.0.0.1'), false, socketOnly), '127.0.0.1');
  assert.equal(clientAddress(fakeReq({ 'x-noevia-client-ip': '1.2.3.4, 5.6.7.8' }, '127.0.0.1'), false, socketOnly), '127.0.0.1');
  assert.equal(clientAddress(fakeReq({}, '127.0.0.1'), false, socketOnly), '127.0.0.1');
  // With TRUST_PROXY and no usable front header, the XFF rule is unchanged.
  assert.equal(clientAddress(fakeReq({ 'x-forwarded-for': '203.0.113.7' }, '127.0.0.1'), true, socketOnly), '203.0.113.7');
});

test('the front\'s answer is what sessions and limits see: a second client behind the same front is a different address', () => {
  const front = { front: true };
  const a = clientAddress(fakeReq({ 'x-noevia-client-ip': '192.168.1.20' }, '127.0.0.1'), false, front);
  const b = clientAddress(fakeReq({ 'x-noevia-client-ip': '192.168.1.21' }, '127.0.0.1'), false, front);
  assert.notEqual(a, b);
  assert.notEqual(a, '127.0.0.1');
});
