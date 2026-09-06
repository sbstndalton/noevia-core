'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRateLimiter, clientAddress } = require('./auth.cjs');

// ── Rate limiter: bounded memory ────────────────────────────────────────────

test('rate limiter allows up to the limit inside the window, then blocks', () => {
  const limiter = createRateLimiter({ sweepMs: 60_000 });
  for (let i = 0; i < 5; i++) assert.equal(limiter.rateLimited('k', 5, 60_000), false);
  assert.equal(limiter.rateLimited('k', 5, 60_000), true);
});

test('rate limiter map stays bounded under a flood of unique keys', () => {
  const limiter = createRateLimiter({ sweepMs: 60_000, maxEntries: 50 });
  for (let i = 0; i < 500; i++) limiter.rateLimited(`login:10.0.0.${i}`, 5, 60_000);
  assert.ok(limiter.size() <= 50, `map size should be capped at 50, got ${limiter.size()}`);
});

test('rate limiter re-admits a key after its window expires', () => {
  const limiter = createRateLimiter({ sweepMs: 10, maxEntries: 100 });
  for (let i = 0; i < 5; i++) limiter.rateLimited('k', 5, 25);
  assert.equal(limiter.rateLimited('k', 5, 25), true);
  // Window is 25ms; wait past it so the next call sweeps the expired entry.
  const start = Date.now();
  while (Date.now() - start < 40) { /* busy-wait */ }
  assert.equal(limiter.rateLimited('k', 5, 25), false);
});

// ── clientAddress: TRUST_PROXY off by default, XFF never trusted blindly ────

function fakeReq(headers, remoteAddress) {
  return { headers, socket: { remoteAddress } };
}

test('without TRUST_PROXY the socket address is used and XFF is ignored', () => {
  const req = fakeReq({ 'x-forwarded-for': '203.0.113.7, 70.41.3.18' }, '10.0.0.9');
  assert.equal(clientAddress(req, false), '10.0.0.9');
  assert.equal(clientAddress(req), '10.0.0.9');
});

test('with TRUST_PROXY the rightmost XFF entry (appended by the trusted proxy) wins', () => {
  const req = fakeReq({ 'x-forwarded-for': '203.0.113.7, 70.41.3.18' }, '10.0.0.9');
  assert.equal(clientAddress(req, true), '70.41.3.18');
});

test('with TRUST_PROXY a single-entry XFF is used', () => {
  const req = fakeReq({ 'x-forwarded-for': '203.0.113.7' }, '10.0.0.9');
  assert.equal(clientAddress(req, true), '203.0.113.7');
});

test('with TRUST_PROXY a malformed or spoofed-format XFF falls back to the socket address', () => {
  assert.equal(clientAddress(fakeReq({ 'x-forwarded-for': 'not-an-ip' }, '10.0.0.9'), true), '10.0.0.9');
  assert.equal(clientAddress(fakeReq({ 'x-forwarded-for': '   ' }, '10.0.0.9'), true), '10.0.0.9');
  assert.equal(clientAddress(fakeReq({}, '10.0.0.9'), true), '10.0.0.9');
});

test('with TRUST_PROXY an IPv6 client IP is accepted from XFF', () => {
  assert.equal(clientAddress(fakeReq({ 'x-forwarded-for': '2606:4700::1111' }, '10.0.0.9'), true), '2606:4700::1111');
});
