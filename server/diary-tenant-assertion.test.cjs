'use strict';
// The M2 tenant assertion builder and the Diary storage-header policy (#291, #292), over fakes:
// no server boots and the sidecar is never contacted. The golden vector is pinned in
// services/diary/tests/test_tenant_assertion.py too, so web and sidecar cannot drift apart.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const { signTenantAssertion, storageSecretRef, canonical, pathOf, ASSERTION_HEADER } = require('./diary-tenant-assertion.cjs');
const { createDiary } = require('./diary.cjs');

const A = '11111111-1111-4111-8111-111111111111';
const KEY = 'synthetic-tenant-key';

test('golden vector matches the sidecar reference signer', () => {
  const value = signTenantAssertion({ key: 'k', method: 'post', url: 'http://diary:8010/api/file?path=x', headers: { 'X-Cowork-User-ID': A, 'X-Cowork-Storage': 'eyJraW5kIjoibG9jYWwifQ' }, body: '{"path":"a"}', now: 1700000000000, nonce: '0'.repeat(32) });
  assert.equal(value, `v2.1700000000.${'0'.repeat(32)}.nfewKW0P1sYJ_oPynPoP1cOgZio8VF0OmX3Q5gIvQbc`);
  assert.equal(storageSecretRef('k', A, 's3cret'), '3bc946714e8992b28033c5c925ede7b1');
});

test('the assertion binds tenant, method, path, query, body, storage and markers, with a fresh nonce', () => {
  const headers = { 'X-Cowork-User-ID': A, 'X-Cowork-Storage': 'abc' };
  const one = signTenantAssertion({ key: KEY, method: 'GET', url: 'http://d/api/day?month=2026-09', headers, now: 1e12 });
  const two = signTenantAssertion({ key: KEY, method: 'GET', url: 'http://d/api/day?month=2026-09', headers, now: 1e12 });
  assert.match(one, /^v2\.1000000000\.[0-9a-f]{32}\.[A-Za-z0-9_-]{43}$/);
  assert.notEqual(one, two);
  const base = { userId: A, ts: 1, nonce: 'n', method: 'GET', path: '/api/day', storage: 'abc' };
  const sig = (m) => crypto.createHmac('sha256', KEY).update(canonical(m)).digest('base64url');
  for (const changed of [{ userId: '22222222-2222-4222-8222-222222222222' }, { method: 'DELETE' }, { path: '/api/internal/tenant' }, { queryHash: 'q' }, { bodyHash: 'stream' }, { storage: 'xyz' }, { legacyOwner: '1' }, { blocked: '1' }]) {
    assert.notEqual(sig({ ...base, ...changed }), sig(base));
  }
  assert.equal(sig({ ...base, userId: A.toUpperCase() }), sig(base));
  const at = (over) => signTenantAssertion({ key: KEY, method: 'POST', url: 'http://d/api/file?path=a', headers: { 'X-Cowork-User-ID': A, 'Content-Type': 'application/json' }, body: '{"a":1}', now: 1e12, nonce: '1'.repeat(32), ...over });
  assert.notEqual(at({ url: 'http://d/api/file?path=b' }), at({}));
  assert.notEqual(at({ body: '{"a":2}' }), at({}));
  assert.equal(at({ body: Buffer.from('{"a":1}') }), at({}), 'string and Buffer of the same bytes sign alike');
  // A non-JSON body signs the "stream" marker: its bytes are not covered.
  const zip = (body) => at({ headers: { 'X-Cowork-User-ID': A, 'Content-Type': 'application/zip' }, body });
  assert.equal(zip('one'), zip('two'));
});

test('the signed path is the percent-encoded wire path (sidecar signs ASGI raw_path)', () => {
  // Same invariant as test_path_is_signed_percent_encoded_as_on_the_wire in the sidecar tests.
  assert.equal(pathOf('http://d/api/a%20b?x=1'), '/api/a%20b');
  assert.equal(pathOf('http://d/api/a b'), '/api/a%20b');
});

function fixture({ key = KEY, storage, approved = true, reply } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-diary-m2-'));
  const requestScope = new AsyncLocalStorage();
  const fetched = [];
  const diary = createDiary({
    fs, path, DIARY_BASE: 'http://diary:8010', DIARY_TOKEN: 'sidecar-token', DIARY_TENANT_KEY: key, DIARY_SOURCE: 'sidecar', requestScope,
    fetchJson: async (url, init) => { fetched.push({ url, init }); return reply ? reply(url, init, fetched.length) : { ok: true, status: 200, body: {} }; },
    authService: { getStorage: () => storage, diaryEnabled: () => true, publicUser: (r) => r, db: { prepare: () => ({ get: (id) => ({ id }) }) } },
    endpointApproved: () => approved,
    workspaceStore: { get: (id) => ({ userId: id, dir: path.join(dir, id) }) },
  });
  const asUser = (fn) => requestScope.run({ workspace: { userId: A, dir: path.join(dir, A) }, authn: { user: { id: A } } }, fn);
  const decode = (h) => JSON.parse(Buffer.from(h['X-Cowork-Storage'], 'base64url').toString());
  return { diary, fetched, asUser, decode };
}

const remote = { kind: 'webdav', baseUrl: 'https://cloud.example/dav', username: 'one', corpusRoot: 'Diary', secret: 'synthetic-pw', secretConfigured: true };

test('with the key set a remote descriptor carries only its ref unless the secret is asked for', () => {
  const f = fixture({ storage: remote });
  const h = f.asUser(() => f.diary.diaryHeaders('GET', 'http://diary:8010/api/day'));
  assert.equal(JSON.stringify(h).includes('synthetic-pw'), false);
  assert.equal(f.decode(h).secretRef, storageSecretRef(KEY, A, 'synthetic-pw'));
  assert.ok(h[ASSERTION_HEADER]);
  const withSecret = f.decode(f.asUser(() => f.diary.diaryHeaders('POST', 'http://diary:8010/api/storage-backup', { secret: true })));
  assert.equal(withSecret.secret, 'synthetic-pw');
  assert.equal(withSecret.secretRef, storageSecretRef(KEY, A, 'synthetic-pw'));
});

test('blocked and local descriptors never carry a secret, even when asked', () => {
  const blocked = fixture({ storage: remote, approved: false });
  const hb = blocked.asUser(() => blocked.diary.diaryHeaders('GET', 'http://diary:8010/api/day', { secret: true }));
  assert.deepEqual(blocked.decode(hb), { kind: 'blocked' });
  assert.ok(hb[ASSERTION_HEADER]);
  const local = fixture({ storage: { kind: 'local', baseUrl: '', username: '', corpusRoot: '', secret: 'stray' } });
  const hl = local.asUser(() => local.diary.diaryHeaders('GET', 'http://diary:8010/api/day', { secret: true }));
  assert.equal(JSON.stringify(local.decode(hl)).includes('stray'), false);
  assert.equal(local.decode(hl).secretRef, undefined);
});

test('without the key nothing changes: no assertion, and the secret rides along for an older sidecar', () => {
  const f = fixture({ key: '', storage: remote });
  const h = f.asUser(() => f.diary.diaryHeaders('GET', 'http://diary:8010/api/day'));
  assert.equal(h[ASSERTION_HEADER], undefined);
  assert.equal(f.decode(h).secret, 'synthetic-pw');
  assert.equal(f.decode(h).secretRef, undefined);
});

test('a 428 from the sidecar is retried once with the secret and a new assertion', async () => {
  const f = fixture({ storage: remote, reply: (url, init, n) => (n === 1 ? { ok: false, status: 428, body: { detail: { code: 'storage_credential_required' } } } : { ok: true, status: 200, body: { files: [] } }) });
  const r = await f.asUser(() => f.diary.diaryFetchJson('http://diary:8010/api/files?path=', {}, 1000));
  assert.equal(r.status, 200);
  assert.equal(f.fetched.length, 2);
  assert.equal(f.decode(f.fetched[0].init.headers).secret, undefined);
  assert.equal(f.decode(f.fetched[1].init.headers).secret, 'synthetic-pw');
  assert.notEqual(f.fetched[0].init.headers[ASSERTION_HEADER], f.fetched[1].init.headers[ASSERTION_HEADER]);
  const once = fixture({ storage: remote, reply: () => ({ ok: false, status: 428, body: {} }) });
  assert.equal((await once.asUser(() => once.diary.diaryFetchJson('http://diary:8010/api/day', {}, 1000))).status, 428);
  assert.equal(once.fetched.length, 2);
});

test('tenant deletion headers are signed for DELETE and carry no storage', () => {
  const f = fixture({ storage: remote });
  const h = f.diary.tenantHeaders(A, 'DELETE', 'http://diary:8010/api/internal/tenant');
  assert.equal(h['X-Cowork-User-ID'], A);
  assert.equal(h.Authorization, 'Bearer sidecar-token');
  assert.equal(h['X-Cowork-Storage'], undefined);
  assert.ok(h[ASSERTION_HEADER].startsWith('v2.'));
  assert.equal(fixture({ key: '' }).diary.tenantHeaders(A, 'DELETE', 'x')[ASSERTION_HEADER], undefined);
});

test('the 428 retry re-signs the same buffered body and query with a fresh nonce', async () => {
  const f = fixture({ storage: remote, reply: (url, init, n) => (n === 1 ? { ok: false, status: 428, body: {} } : { ok: true, status: 200, body: {} }) });
  const body = JSON.stringify({ path: 'notes.md' });
  await f.asUser(() => f.diary.diaryFetchJson('http://diary:8010/api/file?v=1', { method: 'POST', body }, 1000));
  for (const { url, init } of f.fetched) {
    const [, ts, nonce] = init.headers[ASSERTION_HEADER].split('.');
    const expected = signTenantAssertion({ key: KEY, method: 'POST', url, headers: init.headers, body: init.body, now: Number(ts) * 1000, nonce });
    assert.equal(init.headers[ASSERTION_HEADER], expected);
    assert.equal(init.body, body);
  }
  assert.notEqual(f.fetched[0].init.headers[ASSERTION_HEADER].split('.')[2], f.fetched[1].init.headers[ASSERTION_HEADER].split('.')[2]);
});

test('every Diary call made inside a workspace scope names the tenant and is signed', async () => {
  const f = fixture({ storage: remote, reply: () => ({ ok: true, status: 200, body: { months: [], files: [] } }) });
  await f.asUser(async () => {
    await f.diary.corpusSource.listMonths();
    await f.diary.corpusSource.readMonth('2026-09');
    await f.diary.diaryFetchJson('http://diary:8010/api/storage-status', {}, 1000);
  });
  await f.diary.connectorFiles.list(A, 'x');
  await f.diary.connectorFiles.read(A, 'x');
  await f.diary.connectorFiles.write(A, { path: 'x', content: 'y' });
  assert.equal(f.fetched.length, 6);
  for (const { init } of f.fetched) {
    assert.equal(init.headers['X-Cowork-User-ID'], A);
    assert.match(init.headers[ASSERTION_HEADER], /^v2\./);
  }
});
