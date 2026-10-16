'use strict';
// The rate limiter Node's remaining limits use, and the TRUST_PROXY startup warning (#927). Password
// sign-in and its limits are the Rust front's (sbstndalton/noevia#1071; noevia-rs crates/server-account).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createAuth, createRateLimiter, trustProxyWarning } = require('./auth.cjs');

const ORIGIN = 'https://cowork.example.test';

test('rate limiter clear and release give counts back', () => {
  const limiter = createRateLimiter();
  let last;
  for (let i = 0; i < 5; i++) last = limiter.charge('k', 5, 60_000);
  limiter.release('k', last.window);
  assert.equal(limiter.rateLimited('k', 5, 60_000), false);
  assert.equal(limiter.rateLimited('k', 5, 60_000), true);
  limiter.clear('k');
  assert.equal(limiter.blocked('k', 0), false);
  limiter.release('missing', last.window);
  assert.equal(limiter.size(), 0);
});

test('a call counted in one window is not refunded from the next', () => {
  let now = 1_000;
  const limiter = createRateLimiter({ now: () => now });
  const early = limiter.charge('k', 2, 100); // window [1000, 1100)
  now = 1_150; // the window rolls over while the request is in flight
  for (let i = 0; i < 3; i++) limiter.charge('k', 2, 100);
  assert.equal(limiter.blocked('k', 2), true);
  limiter.release('k', early.window);
  assert.equal(limiter.blocked('k', 2), true, 'a stale refund lifted the new window below its limit');
  const current = limiter.charge('k', 2, 100);
  limiter.release('k', current.window);
  assert.equal(limiter.blocked('k', 2), true);
  now = 1_300;
  assert.equal(limiter.blocked('k', 2), false, 'windows still expire on the injected clock');
});

test('startup warns when a public https address runs with TRUST_PROXY off', (t) => {
  assert.match(trustProxyWarning(ORIGIN, false), /TRUST_PROXY is off/);
  assert.equal(trustProxyWarning(ORIGIN, true), '');
  assert.equal(trustProxyWarning('http://192.168.1.20:8021', false), '');
  assert.equal(trustProxyWarning('', false), '');
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
  for (const trustProxy of [false, true]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-proxy-warn-'));
    try { createAuth({ dataDir: root, publicOrigin: 'https://secret-host.example.test', trustProxy }).db.close(); } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
  const proxy = warnings.filter((w) => /TRUST_PROXY/.test(w));
  assert.equal(proxy.length, 1, 'warned once, only with TRUST_PROXY off');
  assert.doesNotMatch(proxy[0], /secret-host/, 'configuration values are not logged');
});
