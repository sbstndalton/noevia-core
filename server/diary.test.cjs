'use strict';
// The Diary sidecar client with a fake tenant: which headers each call carries, the blocked
// storage descriptor, the corpus reads, and the per-user file bridge the connector uses. The
// routes are routes/diary.test.cjs; the sidecar itself is never contacted (synthetic fetch).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const { createDiary } = require('./diary.cjs');

function fixture({ storage = { kind: 'local' }, approved = true, source = 'sidecar', reply } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-diary-'));
  const requestScope = new AsyncLocalStorage();
  const fetched = [];
  const users = { u1: { id: 'u1', username: 'one', role: 'member', disabled_at: null }, u2: { id: 'u2', username: 'two', role: 'member', disabled_at: null } };
  const diaryOn = new Set(['u1']);
  const diary = createDiary({
    fs, path,
    fetchJson: async (url, init) => { fetched.push({ url, init }); return reply ? reply(url, init) : { ok: true, status: 200, body: {} }; },
    DIARY_BASE: 'http://diary:8010', DIARY_TOKEN: 'sidecar-token', DIARY_SOURCE: source,
    requestScope,
    authService: {
      getStorage: () => storage,
      diaryEnabled: (id) => diaryOn.has(id),
      publicUser: (row) => (row ? { id: row.id, username: row.username, role: row.role } : null),
      db: { prepare: () => ({ get: (id) => (users[id] && !users[id].disabled_at ? users[id] : undefined) }) },
    },
    endpointApproved: () => approved,
    workspaceStore: { get: (id) => ({ userId: id, dir: path.join(dir, id) }) },
  });
  const asUser = (id, fn) => requestScope.run({ workspace: { userId: id, dir: path.join(dir, id) }, authn: { user: users[id] } }, fn);
  return { diary, fetched, asUser, dir, users, diaryOn };
}

test('outside a request the headers carry only the sidecar token', () => {
  const { diary } = fixture();
  assert.deepEqual(diary.diaryHeaders(), { 'Content-Type': 'application/json', Authorization: 'Bearer sidecar-token' });
});

test('inside a request the headers name the tenant, the legacy owner and the storage descriptor', () => {
  const f = fixture({ storage: { kind: 'webdav', baseUrl: 'https://cloud.example/dav', username: 'one', secret: 's' } });
  const h = f.asUser('u1', () => f.diary.diaryHeaders());
  assert.equal(h['X-Cowork-User-ID'], 'u1');
  assert.equal(h['X-Cowork-Legacy-Owner'], undefined);
  assert.deepEqual(JSON.parse(Buffer.from(h['X-Cowork-Storage'], 'base64url').toString()), { kind: 'webdav', baseUrl: 'https://cloud.example/dav', username: 'one', secret: 's' });
  fs.mkdirSync(path.join(f.dir, 'u1'), { recursive: true });
  fs.writeFileSync(path.join(f.dir, 'u1', 'migration.json'), '{}');
  assert.equal(f.asUser('u1', () => f.diary.diaryHeaders())['X-Cowork-Legacy-Owner'], '1');
});

test('storage that fails the origin policy is sent as blocked, never as its credentials', () => {
  const f = fixture({ storage: { kind: 'webdav', baseUrl: 'http://10.0.0.9/dav', username: 'one', secret: 'pw' }, approved: false });
  const h = f.asUser('u1', () => f.diary.diaryHeaders());
  assert.equal(h['X-Cowork-Storage-Blocked'], '1');
  assert.deepEqual(JSON.parse(Buffer.from(h['X-Cowork-Storage'], 'base64url').toString()), { kind: 'blocked' });
  assert.equal(JSON.stringify(h).includes('pw'), false);
});

test('the sidecar corpus source lists real months sorted and reads a month or today', async () => {
  const f = fixture({ reply: (url) => (url.endsWith('/api/months')
    ? { ok: true, status: 200, body: { months: [{ id: '2026-09', label: 'September 2026' }, { id: 'nope' }, { id: '2026-08' }] } }
    : url.includes('month=') ? { ok: true, status: 200, body: { log: 'MONTH', standing: 'S' } } : { ok: true, status: 200, body: { today_log: 'TODAY' } }) });
  assert.equal(f.diary.corpusSource.name, 'sidecar');
  assert.deepEqual(await f.diary.corpusSource.listMonths(), [{ id: '2026-08', label: '2026-08' }, { id: '2026-09', label: 'September 2026' }]);
  assert.deepEqual(await f.diary.corpusSource.readMonth('2026-09'), { todayLog: 'MONTH', standing: 'S' });
  assert.deepEqual(await f.diary.corpusSource.readMonth(null), { todayLog: 'TODAY', standing: '' });
  assert.equal(f.fetched[1].url, 'http://diary:8010/api/day?month=2026-09');
  const down = fixture({ reply: () => { throw new Error('unreachable'); } });
  assert.deepEqual(await down.diary.corpusSource.listMonths(), [], 'a failed listing is an empty list, not an error');
  const failing = fixture({ reply: () => ({ ok: false, status: 503, body: null }) });
  await assert.rejects(failing.diary.corpusSource.readMonth(null), /sidecar 503/);
});

test('an unimplemented corpus source says so by name', async () => {
  const { diary } = fixture({ source: 'local' });
  assert.equal(diary.corpusSource.name, 'local');
  await assert.rejects(diary.corpusSource.listMonths(), /corpus source 'local' not implemented yet/);
  await assert.rejects(diary.corpusSource.readMonth('x'), /corpus source 'local' not implemented yet/);
});

test('callDiaryFile runs as the named user and refuses accounts without the Diary', async () => {
  const f = fixture({ reply: (url, init) => ({ ok: true, status: 200, body: { files: [url, init.headers['X-Cowork-User-ID']] } }) });
  assert.deepEqual(await f.diary.connectorFiles.list('u1', 'Notes/a b'), ['http://diary:8010/api/files?path=Notes%2Fa%20b', 'u1']);
  assert.equal(f.fetched[0].init.method, 'GET');
  await f.diary.connectorFiles.write('u1', { path: 'x.md', content: 'c' });
  assert.equal(f.fetched[1].init.method, 'PUT');
  assert.equal(f.fetched[1].init.body, '{"path":"x.md","content":"c"}');
  await assert.rejects(f.diary.callDiaryFile('u2', '/file', 'POST', {}), (e) => e.status === 403 && e.message === 'Diary unavailable');
  await assert.rejects(f.diary.callDiaryFile('ghost', '/file', 'POST', {}), (e) => e.status === 403);
  const failing = fixture({ reply: () => ({ ok: false, status: 409, body: { detail: 'stale version' } }) });
  await assert.rejects(failing.diary.connectorFiles.read('u1', 'x.md'), (e) => e.status === 409 && e.message === 'stale version');
  const silent = fixture({ reply: () => ({ ok: false, status: 0, body: null }) });
  await assert.rejects(silent.diary.connectorFiles.read('u1', 'x.md'), (e) => e.status === 502 && /read the current version before retrying a write/.test(e.message));
});
