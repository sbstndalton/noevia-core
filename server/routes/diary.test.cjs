'use strict';
// The three Diary mounts over fakes: the connector endpoint's own checks (method, no browser
// origin, rate, credential), the credential list/create/revoke, and the /api/diary/* block with
// its add-on gate, method guards and the words it keeps. The sidecar client is diary.test.cjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createDiaryRoutes } = require('./diary.cjs');

function fixture({ diaryOn = true, limited = false, connectorLimited = false, admin = false, reply, clientAddress, addressesTrusted, rateLimitedKeys, log } = {}) {
  const sent = [], fetched = [], audits = [], headers = [];
  const rateKeys = [];
  const credentials = [{ id: 'a'.repeat(32), name: 'Claude Diary' }];
  const routes = createDiaryRoutes({
    json: (res, status, body, extra) => { sent.push({ status, body, ...(extra ? { headers: extra } : {}) }); },
    readBody: async (req) => { let s = ''; for await (const c of req) s += c; return s; },
    readJson: require('../http.cjs').readJson,
    fetchJson: async (url, init) => { fetched.push({ url, init }); return reply ? reply(url, init) : { ok: true, status: 200, body: { ok: true } }; },
    DIARY_BASE: 'http://diary:8010',
    authService: { diaryEnabled: () => diaryOn, audit: (...args) => audits.push(args) },
    currentWorkspace: () => ({ userId: 'u1', dir: '/nowhere' }),
    rateLimited: () => limited,
    connectorRate: { rateLimited: (key, limit) => { rateKeys.push(key); return rateLimitedKeys ? rateLimitedKeys.has(key) : connectorLimited; } },
    clientAddress, addressesTrusted,
    diaryConnectors: {
      verify: (token) => (token === 'good' ? { id: credentials[0].id, userId: 'u1' } : null),
      list: () => credentials, create: (userId, name) => ({ id: 'b'.repeat(32), name, userId }), revoke: (userId, id) => id === credentials[0].id,
    },
    diary: {
      diaryHeaders: (method, url, opts) => ({ 'X-Cowork-User-ID': 'u1', ...(opts?.storageRetry ? { 'X-Cowork-Storage-Retry': '1' } : {}) }),
      log: log || (() => {}),
      corpusSource: { name: 'sidecar', listMonths: async () => [{ id: '2026-09', label: '2026-09' }], readMonth: async (m) => ({ todayLog: m || 'today', standing: '' }) },
      connectorFiles: { list: async () => [], read: async () => ({}), write: async () => ({}) },
    },
  });
  const call = (mount, method, path, body, { search = '', role = admin ? 'admin' : 'member', reqHeaders = {} } = {}) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
    Object.assign(req, { method, headers: reqHeaders, socket: { remoteAddress: '10.0.0.2' } });
    const res = { setHeader: (k, v) => headers.push([k, v]) };
    return routes[mount](req, res, { path, authn: { user: { id: 'u1', role } }, url: new URL(`http://localhost${path}${search}`) });
  };
  return { call, sent, fetched, audits, headers, credentials, rateKeys };
}

test('the connector endpoint is POST-only, refuses browsers, rate-limits and checks the credential', async () => {
  const f = fixture();
  assert.equal(await f.call('connector', 'POST', '/api/diary-connectors'), false);
  await f.call('connector', 'GET', '/api/diary-connector');
  assert.deepEqual(f.sent.pop(), { status: 405, body: { error: 'POST required' } });
  await f.call('connector', 'POST', '/api/diary-connector', {}, { reqHeaders: { origin: 'https://app.example' } });
  assert.deepEqual(f.sent.pop(), { status: 403, body: { error: 'Use the authenticated connector client' } });
  await f.call('connector', 'POST', '/api/diary-connector', {}, { reqHeaders: { authorization: 'Bearer nope' } });
  assert.deepEqual(f.sent.pop(), { status: 401, body: { error: 'Diary connector credential required' } });
  assert.ok(f.headers.some(([k, v]) => k === 'Cache-Control' && v === 'no-store'));
  const limited = fixture({ connectorLimited: true });
  await limited.call('connector', 'POST', '/api/diary-connector', {}, { reqHeaders: { authorization: 'Bearer good' } });
  assert.deepEqual(limited.sent.pop(), { status: 429, body: { error: 'Try later' } });
});

test('#796: the connector rate limit is per credential; unknown tokens use their own bucket and cannot lock out a connector', async () => {
  // Shared tunnel address: a flooded invalid bucket must not touch the good credential's.
  const f = fixture({ clientAddress: () => 'tunnel', rateLimitedKeys: new Set(['diary-connector:invalid']) });
  await f.call('connector', 'POST', '/api/diary-connector', {}, { reqHeaders: { authorization: 'Bearer nope' } });
  assert.deepEqual(f.sent.pop(), { status: 429, body: { error: 'Try later' } });
  await f.call('connector', 'POST', '/api/diary-connector', { action: 'list', path: 'Notes' }, { reqHeaders: { authorization: 'Bearer good' } });
  assert.equal(f.sent.pop().status, 200, 'a working connector is unaffected by the flood of bad tokens');
  assert.deepEqual(f.rateKeys, ['diary-connector:invalid', 'diary-connector:credential:' + 'a'.repeat(32)]);
  assert.ok(!f.rateKeys.some((k) => k.includes('tunnel')), 'the shared address is never a bucket key');
  // A connector over its own budget is limited, and only that one.
  const g = fixture({ rateLimitedKeys: new Set(['diary-connector:credential:' + 'a'.repeat(32)]) });
  await g.call('connector', 'POST', '/api/diary-connector', {}, { reqHeaders: { authorization: 'Bearer good' } });
  assert.deepEqual(g.sent.pop(), { status: 429, body: { error: 'Try later' } });
  // The address joins the invalid bucket only when TRUST_PROXY makes it a real client address.
  const t = fixture({ clientAddress: () => 'proxy-resolved-ip', addressesTrusted: true });
  await t.call('connector', 'POST', '/api/diary-connector', {}, { reqHeaders: {} });
  assert.deepEqual(t.rateKeys, ['diary-connector:invalid:proxy-resolved-ip']);
  assert.equal(t.sent.pop().status, 401);
});

test('a verified connector write is forwarded and audited with its path and size', async () => {
  const f = fixture();
  assert.equal(await f.call('connector', 'POST', '/api/diary-connector', { action: 'list', path: 'Notes' }, { reqHeaders: { authorization: 'Bearer good' } }), true);
  assert.equal(f.sent.pop().status, 200);
  assert.equal(f.audits.length, 0, 'a read is not audited');
  await f.call('connector', 'POST', '/api/diary-connector', { action: 'write', path: 'Notes/a.md', content: 'hello', version: null }, { reqHeaders: { authorization: 'Bearer good' } });
  const reply = f.sent.pop();
  assert.equal(reply.status, 200, JSON.stringify(reply));
  assert.equal(f.audits.length, 1);
  assert.equal(f.audits[0][0], 'diary-connector.write');
  assert.deepEqual(f.audits[0][3], { credentialId: 'a'.repeat(32), path: 'Notes/a.md', bytes: 5 });
});

test('credentials are listed, created with a name and revoked by id', async () => {
  const f = fixture();
  assert.equal(await f.call('connectors', 'GET', '/api/profile/diary-connectors/'), false);
  await f.call('connectors', 'GET', '/api/profile/diary-connectors');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { connectors: f.credentials } });
  await f.call('connectors', 'POST', '/api/profile/diary-connectors', { name: 'Phone' });
  assert.deepEqual(f.sent.pop(), { status: 201, body: { id: 'b'.repeat(32), name: 'Phone', userId: 'u1' } });
  await f.call('connectors', 'DELETE', `/api/profile/diary-connectors/${'a'.repeat(32)}`);
  assert.deepEqual(f.sent.pop(), { status: 200, body: { revoked: true } });
  await f.call('connectors', 'DELETE', `/api/profile/diary-connectors/${'c'.repeat(32)}`);
  assert.deepEqual(f.sent.pop(), { status: 200, body: { revoked: false } });
  assert.equal(await f.call('connectors', 'DELETE', '/api/profile/diary-connectors/short'), false, 'a malformed id is not a connector route');
});

test('every /api/diary route is gated on the add-on and guards its method', async () => {
  const off = fixture({ diaryOn: false });
  for (const [method, path] of [['GET', '/api/diary/exchanges'], ['GET', '/api/diary/workspace-trash'], ['POST', '/api/diary/workspace-import'], ['GET', '/api/diary/workspace-export'], ['GET', '/api/diary/storage-status'], ['GET', '/api/diary/files'], ['GET', '/api/diary/source'], ['GET', '/api/diary/today'], ['POST', '/api/diary/entries/edit']]) {
    assert.equal(await off.call('diary', method, path, method === 'POST' ? {} : undefined), true, path);
    assert.deepEqual(off.sent.pop(), { status: 404, body: { error: 'Diary add-on is disabled' } }, path);
  }
  const f = fixture();
  await f.call('diary', 'DELETE', '/api/diary/workspace-trash');
  assert.deepEqual(f.sent.pop(), { status: 405, body: { error: 'Method not allowed' } });
  await f.call('diary', 'GET', '/api/diary/storage-import');
  assert.deepEqual(f.sent.pop(), { status: 405, body: { error: 'Method not allowed' } });
  await f.call('diary', 'DELETE', '/api/diary/file');
  assert.deepEqual(f.sent.pop(), { status: 405, body: { error: 'Method not allowed' } });
  assert.equal(await f.call('diary', 'GET', '/api/diary/entries/edit'), false, 'an unhandled method falls through');
  assert.equal(await f.call('diary', 'GET', '/api/chat'), false);
});

test('the corpus reads, the trash proxy and the local exchange keep their shapes and limits', async () => {
  const f = fixture({ reply: (url) => (url.includes('workspace-trash') ? { ok: false, status: 502, body: null } : { ok: true, status: 200, body: { echo: url } }) });
  await f.call('diary', 'GET', '/api/diary/source');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { source: 'sidecar', months: [{ id: '2026-09', label: '2026-09' }] } });
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


test('malformed local exchange and authenticated connector JSON fail before side effects', async () => {
  const f = fixture();
  await assert.rejects(f.call('diary', 'POST', '/api/diary/local-exchange', '{broken'),
    { status: 400, message: 'invalid JSON' });
  await assert.rejects(f.call('connector', 'POST', '/api/diary-connector', '{broken',
    { reqHeaders: { authorization: 'Bearer good' } }), { status: 400, message: 'invalid JSON' });
  assert.deepEqual(f.fetched, []);
  assert.deepEqual(f.audits, []);
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
