'use strict';
// GET /api/export/conversations: a normal export downloads, an oversized one answers 413 with a
// clear message and is neither audited nor sent (#867). Synthetic histories only.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createExportRoutes } = require('./export.cjs');
const { MAX_EXPORT_ENTRIES } = require('../chat-export.cjs');

function run({ freeChats, readHistory = () => [{ role: 'user', content: 'hello' }], method = 'GET', authn = { user: { id: 'u1' } } }) {
  const audits = [], res = { headers: null, ended: null, status: null, body: null };
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; };
  res.end = (data) => { res.ended = data; };
  const routes = createExportRoutes({
    json: (r, status, body) => { r.status = status; r.body = body; }, workspace: () => ({ freeChats, projects: [] }), readHistory,
    audit: (...a) => audits.push(a), now: () => Date.UTC(2026, 9, 5),
  });
  return routes({ method }, res, { path: '/api/export/conversations', authn }).then((handled) => ({ handled, res, audits }));
}

test('a normal export is a ZIP download and is audited', async () => {
  const { handled, res, audits } = await run({ freeChats: [{ id: 'c-1', title: 'One' }] });
  assert.equal(handled, true);
  assert.equal(res.status, 200);
  assert.equal(res.headers['Content-Type'], 'application/zip');
  assert.equal(res.ended.readUInt32LE(0), 0x04034b50);
  assert.deepEqual(audits, [['export.conversations', 'u1', { bytes: res.ended.length }]]);
});

test('too many chats answer 413 with a readable message, no download, no audit', async () => {
  const freeChats = Array.from({ length: MAX_EXPORT_ENTRIES }, (_, i) => ({ id: `c-${i}`, title: 'x' }));
  let reads = 0;
  const { handled, res, audits } = await run({ freeChats, readHistory: () => { reads++; return []; } });
  assert.equal(handled, true);
  assert.equal(res.status, 413);
  assert.match(res.body.error, /too large to export in one file/);
  assert.equal(res.headers, null);
  assert.equal(res.ended, null);
  assert.equal(audits.length, 0);
  assert.equal(reads, 0);
});

test('an unexpected failure is not disguised as 413', async () => {
  await assert.rejects(run({ freeChats: [{ id: 'c-1', title: 'x' }], readHistory: () => { throw new Error('disk'); } }), /disk/);
});

test('sign-in and method checks still come first', async () => {
  assert.equal((await run({ freeChats: [], authn: null })).res.status, 401);
  assert.equal((await run({ freeChats: [], method: 'POST' })).res.status, 405);
});
