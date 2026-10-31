'use strict';
// The /api/diary/* mount that stays in this process, over fakes: its add-on gate, method guards and
// the words it keeps. The sidecar client is diary.test.cjs. The connector endpoint, the connector
// credentials, the recovery records and the storage status are the Rust front's (#2206): noevia-rs
// crates/server-diary/tests and bins/noevia-server/tests/diary.rs; Node refuses them in rust-diary-routes.test.cjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createDiaryRoutes } = require('./diary.cjs');

function fixture({ dir = '/nowhere', diaryOn = true, limited = false, admin = false, reply, log, storageLatch, readMonth } = {}) {
  const sent = [], fetched = [], headers = [];
  const routes = createDiaryRoutes({
    json: (res, status, body, extra) => { sent.push({ status, body, ...(extra ? { headers: extra } : {}) }); },
    readBody: async (req) => { let s = ''; for await (const c of req) s += c; return s; },
    readJson: require('../http.cjs').readJson,
    fetchJson: async (url, init) => { fetched.push({ url, init }); return reply ? reply(url, init) : { ok: true, status: 200, body: { ok: true } }; },
    DIARY_BASE: 'http://diary:8010',
    authService: { diaryEnabled: () => diaryOn, getStorage: () => ({ kind: 'nextcloud', baseUrl: 'https://cloud.example/dav', username: 'ada', secret: 'synthetic-pw' }) },
    currentWorkspace: () => ({ userId: 'u1', dir }),
    rateLimited: () => limited,
    storageLatch,
    diary: {
      diaryHeaders: (method, url, opts) => ({ 'X-Cowork-User-ID': 'u1', ...(opts?.storageRetry ? { 'X-Cowork-Storage-Retry': '1' } : {}) }),
      log: log || (() => {}),
      corpusSource: { name: 'sidecar', readMonth: readMonth || (async (m) => ({ todayLog: m || 'today', standing: '' })) },
    },
  });
  const call = (mount, method, path, body, { search = '', role = admin ? 'admin' : 'member', reqHeaders = {} } = {}) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
    Object.assign(req, { method, headers: reqHeaders, socket: { remoteAddress: '10.0.0.2' } });
    const res = { setHeader: (k, v) => headers.push([k, v]) };
    return routes[mount](req, res, { path, authn: { user: { id: 'u1', role } }, url: new URL(`http://localhost${path}${search}`) });
  };
  return { call, sent, fetched, headers };
}

test('every /api/diary route this mount keeps is gated on the add-on and guards its method', async () => {
  const off = fixture({ diaryOn: false });
  for (const [method, path] of [['GET', '/api/diary/workspace-trash'], ['GET', '/api/diary/files'], ['GET', '/api/diary/history'], ['POST', '/api/diary/entries/edit']]) {
    assert.equal(await off.call('diary', method, path, method === 'POST' ? {} : undefined), true, path);
    assert.deepEqual(off.sent.pop(), { status: 404, body: { error: 'Diary add-on is disabled' } }, path);
  }
  const f = fixture();
  await f.call('diary', 'DELETE', '/api/diary/workspace-trash');
  assert.deepEqual(f.sent.pop(), { status: 405, body: { error: 'Method not allowed' } });
  await f.call('diary', 'DELETE', '/api/diary/file');
  assert.deepEqual(f.sent.pop(), { status: 405, body: { error: 'Method not allowed' } });
  assert.equal(await f.call('diary', 'GET', '/api/diary/entries/edit'), false, 'an unhandled method falls through');
  assert.equal(await f.call('diary', 'GET', '/api/chat'), false);
  // #2185 and #2206: the routes the Rust front owns are not this mount's any more, in any method, add-on on or off.
  // (Their add-on gate, method guards and answers are noevia-rs crates/server-diary/tests/sidecar.rs;
  // Node refuses them before authentication: rust-diary.test.cjs.)
  for (const path of ['/api/diary/source', '/api/diary/today', '/api/diary/storage-import', '/api/diary/workspace-export', '/api/diary/workspace-import', '/api/diary/exchanges', '/api/diary/storage-status']) {
    for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
      assert.equal(await off.call('diary', method, path, method === 'POST' ? {} : undefined), false, `${method} ${path}`);
      assert.equal(await f.call('diary', method, path, method === 'POST' ? {} : undefined), false, `${method} ${path}`);
    }
  }
  assert.deepEqual(f.fetched, []);
});

test('the history read, the trash proxy and the local exchange keep their shapes and limits', async () => {
  const f = fixture({ reply: (url) => (url.includes('workspace-trash') ? { ok: false, status: 502, body: null } : { ok: true, status: 200, body: { echo: url } }) });
  await f.call('diary', 'GET', '/api/diary/history', undefined, { search: '?month=2026-08' });
  assert.deepEqual(f.sent.pop(), { status: 200, body: { todayLog: '2026-08', standing: '' } });
  await f.call('diary', 'GET', '/api/diary/workspace-trash', undefined, { search: '?after=x' });
  assert.deepEqual(f.sent.pop(), { status: 502, body: { error: 'Diary recovery request failed. Retry or refresh Trash.' } });
  assert.equal(f.fetched.at(-1).url, 'http://diary:8010/api/workspace-trash?after=x');
  await f.call('diary', 'GET', '/api/diary/files', undefined, { search: '?path=Notes' });
  assert.deepEqual(f.sent.pop(), { status: 200, body: { echo: 'http://diary:8010/api/files?path=Notes' } });
  await f.call('diary', 'POST', '/api/diary/local-exchange', { message: 'hi' });
  assert.equal(f.sent.pop().status, 200);
  assert.equal(f.fetched.at(-1).init.headers['X-Cowork-User-ID'], 'u1', 'the tenant headers ride on every sidecar call');
  const busy = fixture({ limited: true });
  await busy.call('diary', 'POST', '/api/diary/local-exchange', { message: 'hi' });
  assert.deepEqual(busy.sent.pop(), { status: 429, body: { error: 'Please wait before sending another message' } });
  assert.equal(busy.fetched.length, 0);
});

test('operator import folders are admin-only and the entry edit validates before forwarding', async () => {
  const member = fixture();
  await member.call('diary', 'GET', '/api/diary/external-sources');
  assert.deepEqual(member.sent.pop(), { status: 403, body: { error: 'Administrator required for server import folders' } });
  await member.call('diary', 'POST', '/api/diary/external-sources/import', {});
  assert.deepEqual(member.sent.pop(), { status: 403, body: { error: 'Administrator required for server import folders' } });
  const admin = fixture({ admin: true, reply: (url) => (url.endsWith('/import') ? { ok: false, status: 404, body: { detail: 'no such folder' } } : { ok: true, status: 200, body: { sources: [] } }) });
  await admin.call('diary', 'GET', '/api/diary/external-sources');
  assert.deepEqual(admin.sent.pop(), { status: 200, body: { sources: [] } });
  await admin.call('diary', 'POST', '/api/diary/external-sources/import', { sourcePath: 'x' });
  assert.deepEqual(admin.sent.pop(), { status: 400, body: { error: 'sourcePath and relPath required' } });
  await admin.call('diary', 'POST', '/api/diary/external-sources/import', { sourcePath: 'x', relPath: 'y' });
  assert.deepEqual(admin.sent.pop(), { status: 404, body: { error: 'no such folder' } });
  assert.equal(admin.fetched.at(-1).init.body, '{"source_path":"x","rel_path":"y"}');
  const f = fixture({ reply: () => ({ ok: false, status: 500, body: { error: 'journal locked' } }) });
  await f.call('diary', 'POST', '/api/diary/entries/edit', '{');
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'invalid JSON' } });
  await f.call('diary', 'POST', '/api/diary/entries/edit', { xid: 'x', me: 'text', assistant: 3 });
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'xid and me required' } });
  await f.call('diary', 'POST', '/api/diary/entries/edit', { xid: 'x', me: 'text' });
  assert.deepEqual(f.sent.pop(), { status: 502, body: { error: 'journal locked' } });
  assert.equal(f.fetched.at(-1).init.body, '{"xid":"x","me":"text","assistant":"","month":null}');
});


test('a malformed local exchange fails before side effects', async () => {
  const f = fixture();
  await assert.rejects(f.call('diary', 'POST', '/api/diary/local-exchange', '{broken'),
    { status: 400, message: 'invalid JSON' });
  assert.deepEqual(f.fetched, []);
});

test('entry edits forward base_hash and relay a 409 conflict body unchanged', async () => {
  const base = 'a'.repeat(64);
  const conflict = { error: 'exchange changed since it was loaded', conflict: true, current_hash: 'b'.repeat(64), current_text: '**Me:** synthetic newer words' };
  const f = fixture({ reply: (url, init) => (JSON.parse(init.body).base_hash === base ? { ok: false, status: 409, body: conflict } : { ok: true, status: 200, body: { ok: true, hash: 'c'.repeat(64) } }) });
  await f.call('diary', 'POST', '/api/diary/entries/edit', { xid: 'x1', me: 'draft', base_hash: base, month: '2026-09' });
  assert.equal(f.fetched.at(-1).init.body, JSON.stringify({ xid: 'x1', me: 'draft', assistant: '', month: '2026-09', base_hash: base }));
  assert.deepEqual(f.sent.pop(), { status: 409, body: conflict });
  await f.call('diary', 'POST', '/api/diary/entries/edit', { xid: 'x1', me: 'draft', base_hash: conflict.current_hash });
  assert.deepEqual(f.sent.pop(), { status: 200, body: { ok: true, hash: 'c'.repeat(64) } });
  await f.call('diary', 'POST', '/api/diary/entries/edit', { xid: 'x1', me: 'draft', base_hash: 7 });
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'base_hash must be a string' } });
  assert.equal(f.fetched.length, 2, 'an invalid base_hash never reaches the sidecar');
  const plain = fixture({ reply: () => ({ ok: false, status: 409, body: { detail: 'etag clash' } }) });
  await plain.call('diary', 'POST', '/api/diary/entries/edit', { xid: 'x1', me: 'draft' });
  assert.deepEqual(plain.sent.pop(), { status: 409, body: { error: 'etag clash' } }, 'non-conflict 409s keep the old shape');
});

test('#849: a storage login the sidecar reports as refused reaches the browser as a 4xx with its stable code', async () => {
  const refused = { ok: false, status: 424, body: { detail: 'Storage login rejected. Check your storage credentials in Settings → Diary & storage.', code: 'storageLoginRejected' } };
  const f = fixture({ reply: () => refused });
  await f.call('diary', 'GET', '/api/diary/files', undefined, { search: '?path=Notes' });
  assert.deepEqual(f.sent.pop(), { status: 424, body: { error: refused.body.detail, code: 'storageLoginRejected' } });
  await f.call('diary', 'POST', '/api/diary/file', { path: 'a.md' });
  assert.deepEqual(f.sent.pop(), { status: 424, body: { error: refused.body.detail, code: 'storageLoginRejected' } });
  // No other sidecar field is passed on, and an ordinary failure keeps its old shape.
  const other = fixture({ reply: () => ({ ok: false, status: 500, body: { detail: 'boom', code: 'internal-detail' } }) });
  await other.call('diary', 'GET', '/api/diary/files');
  assert.deepEqual(other.sent.pop(), { status: 500, body: { error: 'boom' } });
});

test('#1168: a storage throttle reaches the browser with its code, wait and Retry-After header', async () => {
  const throttled = { ok: false, status: 503, body: { detail: 'The storage server is limiting sign-ins. Try again in 42 seconds.', code: 'storageThrottled', retryAfter: 41.2 } };
  const f = fixture({ reply: () => throttled });
  await f.call('diary', 'GET', '/api/diary/files', undefined, { search: '?path=Notes' });
  assert.deepEqual(f.sent.pop(), { status: 503, body: { error: throttled.body.detail, code: 'storageThrottled', retryAfter: 42 }, headers: { 'Retry-After': '42' } });
  // A missing or nonsense wait is dropped, not invented; the code still passes.
  for (const retryAfter of [undefined, 'soon', -5, 0]) {
    const odd = fixture({ reply: () => ({ ok: false, status: 503, body: { detail: 'wait', code: 'storageThrottled', retryAfter } }) });
    await odd.call('diary', 'POST', '/api/diary/file', { path: 'a.md' });
    assert.deepEqual(odd.sent.pop(), { status: 503, body: { error: 'wait', code: 'storageThrottled' } }, String(retryAfter));
  }
  // The wait is capped so a hostile sidecar value cannot become a day-long header.
  const huge = fixture({ reply: () => ({ ok: false, status: 503, body: { detail: 'wait', code: 'storageThrottled', retryAfter: 1e9 } }) });
  await huge.call('diary', 'GET', '/api/diary/files');
  assert.equal(huge.sent.pop().headers['Retry-After'], '86400');
});

test('#1198: forwarding an explicit Retry is logged once with no path, address or secret; automatic reads are silent', async () => {
  const lines = [];
  const f = fixture({ log: (line) => lines.push(line) });
  await f.call('diary', 'GET', '/api/diary/files', undefined, { search: '?path=Private%20Notes', reqHeaders: { 'x-cowork-storage-retry': '1' } });
  await f.call('diary', 'GET', '/api/diary/files', undefined, { search: '?path=Private%20Notes' });
  assert.deepEqual(lines, ['[diary] forwarding X-Cowork-Storage-Retry: 1 (GET /api/diary/files, user u1)']);
  assert.doesNotMatch(lines[0], /Private|Notes|http/);
});

test('#1168: X-Cowork-Storage-Retry: 1 from the browser reaches the sidecar only on a files/file read, and only as "1"', async () => {
  const f = fixture();
  await f.call('diary', 'GET', '/api/diary/files', undefined, { search: '?path=Notes', reqHeaders: { 'x-cowork-storage-retry': '1' } });
  assert.equal(f.fetched.pop().init.headers['X-Cowork-Storage-Retry'], '1', 'an explicit Retry is forwarded');
  await f.call('diary', 'GET', '/api/diary/files', undefined, { search: '?path=Notes' });
  assert.equal('X-Cowork-Storage-Retry' in f.fetched.pop().init.headers, false, 'an automatic read is not');
  for (const value of ['0', 'true', '1,1', '']) {
    await f.call('diary', 'GET', '/api/diary/files', undefined, { reqHeaders: { 'x-cowork-storage-retry': value } });
    assert.equal('X-Cowork-Storage-Retry' in f.fetched.pop().init.headers, false, JSON.stringify(value));
  }
  await f.call('diary', 'POST', '/api/diary/file', { path: 'a.md' }, { reqHeaders: { 'x-cowork-storage-retry': '1' } });
  assert.equal(f.fetched.pop().init.headers['X-Cowork-Storage-Retry'], '1');
  // Not on the chat exchange: a retry press is a file-list action.
  await f.call('diary', 'POST', '/api/diary/local-exchange', { message: 'hi' }, { reqHeaders: { 'x-cowork-storage-retry': '1' } });
  assert.equal('X-Cowork-Storage-Retry' in f.fetched.pop().init.headers, false);
});

// The sidecar's storage-status tells whether an account is kept in the app ('managed') or on the storage server ('legacy').
const listingReply = (mode) => (url) => (String(url).endsWith('/api/storage-status')
  ? (mode ? { ok: true, status: 200, body: { mode } } : { ok: false, status: 500, body: { detail: 'down' } })
  : { ok: true, status: 200, body: { files: [] } });
const RETRY = { search: '?path=Notes', reqHeaders: { 'x-cowork-storage-retry': '1' } };
const heldFixture = (mode) => {
  const { createStorageLatch } = require('../storage-latch.cjs');
  const storageLatch = createStorageLatch({ now: () => 0 });
  const conn = { kind: 'nextcloud', baseUrl: 'https://cloud.example/dav', username: 'ada', secret: 'synthetic-pw' };
  const f = fixture({ storageLatch, reply: listingReply(mode) });
  storageLatch.note('u1', conn, { kind: 'login' });
  return { f, storageLatch, conn };
};

test('#1589: an explicit Retry that works ends the hold; an automatic read that works does not', async () => {
  const { f, storageLatch, conn } = heldFixture('legacy');
  await f.call('diary', 'GET', '/api/diary/files', undefined, { search: '?path=Notes' });
  assert.notEqual(storageLatch.status('u1', conn), null, 'an automatic read proves nothing');
  await f.call('diary', 'GET', '/api/diary/files', undefined, RETRY);
  assert.equal(storageLatch.status('u1', conn), null, 'the person pressed Retry and the storage server answered');
});

test('#1607: a Retry listing that the sidecar answered from its own database (managed mode) does not end the hold', async () => {
  const { f, storageLatch, conn } = heldFixture('managed');
  await f.call('diary', 'GET', '/api/diary/files', undefined, RETRY);
  assert.deepEqual(f.sent.pop(), { status: 200, body: { files: [] } }, 'the listing itself is still returned');
  assert.notEqual(storageLatch.status('u1', conn), null, 'a local answer says nothing about the saved login');
  await f.call('diary', 'POST', '/api/diary/file', { path: 'a.md' }, RETRY);
  assert.notEqual(storageLatch.status('u1', conn), null, 'nor does a local file read');
});

test('#1607: when the sidecar cannot say which kind of account it is, the hold stays', async () => {
  const { f, storageLatch, conn } = heldFixture(null);
  await f.call('diary', 'GET', '/api/diary/files', undefined, RETRY);
  assert.equal(f.sent.pop().status, 200);
  assert.notEqual(storageLatch.status('u1', conn), null);
});

// sbstndalton/noevia#2232: a Diary that cannot be reached (the network call fails) is a 503 the page can
// word, with a stable code and no address or error text; it used to reach http.cjs as a bare 500. Only a
// network or abort failure is "unavailable": a redirect (fetchJson uses redirect:'error') or a failure while
// building the tenant headers is a bug and stays a 500, and is logged by class.
const refused = (code = 'ECONNREFUSED') => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(`connect ${code} 10.1.2.3:8010`), { code, address: '10.1.2.3' }) });
const ROUTES = [['GET', '/api/diary/files', undefined], ['PUT', '/api/diary/file', '{}'], ['POST', '/api/diary/local-exchange', { message: 'hi' }], ['GET', '/api/diary/workspace-trash', undefined],
  ['GET', '/api/diary/history', undefined], ['GET', '/api/diary/external-sources', undefined],
  ['POST', '/api/diary/external-sources/import', { sourcePath: '/a', relPath: 'b' }],
  ['POST', '/api/diary/entries/edit', { xid: 'x', me: 'm' }]];

test('#2232: an unreachable Diary answers 503 diaryUnavailable on every Node-owned Diary route', async () => {
  const unavailable = { status: 503, body: { error: 'Diary is unavailable right now. Try again shortly.', code: 'diaryUnavailable' } };
  // EAI_AGAIN (the resolver is down while the sidecar restarts) has an underscore: #2245.
  for (const reply of [() => { throw refused(); }, () => { throw refused('EAI_AGAIN'); }, () => { throw refused('ENOTFOUND'); }, () => { throw Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' }); }]) {
    const lines = [];
    const f = fixture({ admin: true, reply, readMonth: async () => reply(), log: (l) => lines.push(l) });
    for (const [method, path, body] of ROUTES) {
      assert.equal(await f.call('diary', method, path, body), true, path);
      const answered = f.sent.pop();
      assert.deepEqual(answered, unavailable, path);
      assert.doesNotMatch(JSON.stringify(answered), /10\.1\.2\.3|ECONN|EAI_|ENOTFOUND|fetch failed/);
    }
    assert.ok(lines.length > 0 && lines.every((l) => /unavailable/.test(l) && !/10\.1\.2\.3/.test(l)), 'logged by class');
  }
});

// noevia#2252 (review of core#294): the code pattern also matched every ERR_* code, so a bad DIARY_BASE
// (ERR_INVALID_URL) or a TLS fault read as "unavailable". Socket and resolver codes only.
test('#2252: ERR_* codes (a bad DIARY_BASE, a TLS fault) stay internal; socket, resolver and undici codes are unavailable', async () => {
  for (const code of ['ERR_INVALID_URL', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_SSL_WRONG_VERSION_NUMBER', 'ERR_INVALID_ARG_TYPE']) {
    const lines = [];
    const f = fixture({ reply: () => { throw refused(code); }, log: (l) => lines.push(l) });
    await assert.rejects(f.call('diary', 'GET', '/api/diary/files'), /fetch failed/, code);
    assert.equal(f.sent.length, 0, code);
    assert.match(lines[0], /\(internal\)/, code);
  }
  for (const code of ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'EAI_NODATA', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']) {
    const f = fixture({ reply: () => { throw refused(code); } });
    assert.equal(await f.call('diary', 'GET', '/api/diary/files'), true, code);
    assert.equal(f.sent.pop().status, 503, code);
  }
});

test('#2232: a redirect or a failure building the tenant headers is not "unavailable"', async () => {
  const redirect = () => { throw Object.assign(new TypeError('fetch failed'), { cause: new Error('unexpected redirect') }); };
  const lines = [];
  const f = fixture({ reply: redirect, log: (l) => lines.push(l) });
  await assert.rejects(f.call('diary', 'GET', '/api/diary/files'), /fetch failed/);
  assert.equal(f.sent.length, 0);
  assert.match(lines[0], /TypeError.*\(internal\)/);
  const g = fixture({ reply: () => { throw new Error('storage row unreadable /srv/secret'); }, log: (l) => lines.push(l) });
  await assert.rejects(g.call('diary', 'GET', '/api/diary/files'), /storage row/);
  assert.equal(g.sent.length, 0);
  assert.ok(lines.every((l) => !l.includes('/srv/secret')));
});
