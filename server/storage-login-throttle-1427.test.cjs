'use strict';
// #1427: Nextcloud's brute-force protection answers 429. checkLogin reports that as throttling, not
// as a wrong password (401) and not as an unreachable server, so Settings can say what happened.
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkLogin } = require('./storage-client.cjs');

const conn = { baseUrl: 'https://cloud.example/remote.php/dav/files/ada', username: 'ada', secret: 'synthetic-secret' };

test('429 is throttling, with the server\'s Retry-After when it sends one', async () => {
  const withWait = await checkLogin(conn, { fetchImpl: async () => new Response('', { status: 429, headers: { 'Retry-After': '90' } }) });
  assert.deepEqual(withWait, { ok: false, throttled: true, status: 429, retryAfter: 90 });
  const bare = await checkLogin(conn, { fetchImpl: async () => new Response('', { status: 429 }) });
  assert.deepEqual(bare, { ok: false, throttled: true, status: 429 });
  assert.doesNotMatch(JSON.stringify(withWait), /synthetic-secret/);
});

test('401 stays a rejected login and a timeout stays unverified', async () => {
  assert.deepEqual(await checkLogin(conn, { fetchImpl: async () => new Response('', { status: 401 }) }), { ok: false, rejected: true, status: 401 });
  const slow = await checkLogin(conn, { fetchImpl: async () => { throw Object.assign(new Error('slow'), { name: 'TimeoutError' }); } });
  assert.deepEqual(slow, { ok: false, unverified: 'timeout' });
});
