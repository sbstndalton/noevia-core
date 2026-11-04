'use strict';
// The /api/diary/* mount that stays in this process, over fakes: POST /api/diary/local-exchange (the
// shared inference gate and throttle), its add-on gate, method guard and the words it keeps. The sidecar
// client is diary.test.cjs. Everything else is the Rust front's:
// - the connector endpoint, the connector credentials, the recovery records and the storage status
//   (#2206): noevia-rs crates/server-diary/tests and bins/noevia-server/tests/diary.rs; Node refuses them in
//   rust-diary-routes.test.cjs;
// - the files and file proxies, the workspace trash, the history read, the operator import folders and the
//   journaled entry edit (the Diary proxy port): Node refuses them before authentication in
//   rust-diary.test.cjs. Their gate, method guards, admin check, body limits, validation, 409 conflict relay,
//   storage codes and Retry-After, unavailable/internal split and the explicit-Retry hold (#849, #1168,
//   #1589, #1607, #2232, #2252) are checked against an oracle generated from the Core handlers this file
//   used to test: noevia-rs crates/server-diary/tests/proxy_parity.rs:25 (actual_core_proxy_oracle),
//   :131 (explicit_retry_clears_only_after_legacy_proof_and_timeouts_are_bounded), :258
//   (redirect_and_configuration_failures_remain_internal_errors), :299
//   (valid_js_json_and_conflict_text_match_the_actual_core_handlers), and on the wire in
//   bins/noevia-server/tests/diary.rs:1028 (moved_proxy_headers_survive_the_front_response_adapter).
//   The browser's explicit Retry (#1168: only exactly one "1", not 0/true/"1,1"/empty/repeated; forwarded
//   on the listing and a POST or PUT file call only) and the hold it may clear (#1589/#1607: only a working
//   call whose storage-status says legacy; not managed, a failed or erroring proof, or a failed call) are
//   driven through the front's request handling in bins/noevia-server/tests/diary.rs:1206
//   (only_the_browsers_exact_retry_header_is_forwarded_on_a_files_or_file_call) and :1274
//   (an_explicit_retry_clears_the_hold_only_with_legacy_proof).
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createDiaryRoutes } = require('./diary.cjs');

function fixture({ diaryOn = true, limited = false, admin = false, reply, log, diaryHeaders } = {}) {
  const sent = [], fetched = [], headers = [];
  const routes = createDiaryRoutes({
    json: (res, status, body, extra) => { sent.push({ status, body, ...(extra ? { headers: extra } : {}) }); },
    readJson: require('../http.cjs').readJson,
    fetchJson: async (url, init) => { fetched.push({ url, init }); return reply ? reply(url, init) : { ok: true, status: 200, body: { ok: true } }; },
    DIARY_BASE: 'http://diary:8010',
    authService: { diaryEnabled: () => diaryOn, getStorage: () => ({ kind: 'nextcloud', baseUrl: 'https://cloud.example/dav', username: 'ada', secret: 'synthetic-pw' }) },
    rateLimited: () => limited,
    diary: {
      diaryHeaders: diaryHeaders || ((method, url, opts) => ({ 'X-Cowork-User-ID': 'u1', ...(opts?.storageRetry ? { 'X-Cowork-Storage-Retry': '1' } : {}) })),
      log: log || (() => {}),
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

const MOVED = ['/api/diary/files', '/api/diary/file', '/api/diary/workspace-trash', '/api/diary/history',
  '/api/diary/external-sources', '/api/diary/external-sources/import', '/api/diary/entries/edit'];
const LOCAL = ['POST', '/api/diary/local-exchange', { message: 'hi' }];

test('the local exchange this mount keeps is gated on the add-on and guards its method', async () => {
  const off = fixture({ diaryOn: false });
  assert.equal(await off.call('diary', ...LOCAL), true);
  assert.deepEqual(off.sent.pop(), { status: 404, body: { error: 'Diary add-on is disabled' } });
  const f = fixture();
  for (const method of ['GET', 'PUT', 'DELETE']) {
    assert.equal(await f.call('diary', method, '/api/diary/local-exchange'), true, method);
    assert.deepEqual(f.sent.pop(), { status: 405, body: { error: 'Method not allowed' } }, method);
  }
  assert.equal(await f.call('diary', 'GET', '/api/chat'), false);
  // #2185, #2206 and the Diary proxy port: the routes the Rust front owns are not this mount's any more, in
  // any method, add-on on or off, admin or member. (rust-diary.cjs refuses them before authentication, and the
  // non-POST import/edit methods still fall through as before: rust-diary.test.cjs.)
  for (const path of [...MOVED, '/api/diary/source', '/api/diary/today', '/api/diary/storage-import', '/api/diary/workspace-export', '/api/diary/workspace-import', '/api/diary/exchanges', '/api/diary/storage-status']) {
    for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
      for (const role of ['member', 'admin']) {
        assert.equal(await off.call('diary', method, path, method === 'POST' ? {} : undefined, { role }), false, `${method} ${path}`);
        assert.equal(await f.call('diary', method, path, method === 'POST' ? {} : undefined, { role, reqHeaders: { 'x-cowork-storage-retry': '1' } }), false, `${method} ${path}`);
      }
    }
  }
  assert.deepEqual(f.fetched, [], 'a moved route never reaches the sidecar from this process');
  assert.deepEqual(f.sent, []);
});

test('the local exchange keeps its shape and limits', async () => {
  const f = fixture({ reply: (url) => ({ ok: true, status: 200, body: { echo: url } }) });
  await f.call('diary', ...LOCAL);
  assert.deepEqual(f.sent.pop(), { status: 200, body: { echo: 'http://diary:8010/api/local-exchange' } });
  assert.equal(f.fetched.at(-1).init.method, 'POST');
  assert.equal(f.fetched.at(-1).init.body, '{"message":"hi"}');
  assert.equal(f.fetched.at(-1).init.headers['X-Cowork-User-ID'], 'u1', 'the tenant headers ride on every sidecar call');
  const busy = fixture({ limited: true });
  await busy.call('diary', ...LOCAL);
  assert.deepEqual(busy.sent.pop(), { status: 429, body: { error: 'Please wait before sending another message' } });
  assert.equal(busy.fetched.length, 0);
});

test('a malformed local exchange fails before side effects', async () => {
  const f = fixture();
  await assert.rejects(f.call('diary', 'POST', '/api/diary/local-exchange', '{broken'),
    { status: 400, message: 'invalid JSON' });
  assert.deepEqual(f.fetched, []);
});

test('#849: a storage login the sidecar reports as refused reaches the browser as a 4xx with its stable code', async () => {
  const refused = { ok: false, status: 424, body: { detail: 'Storage login rejected. Check your storage credentials in Settings → Diary & storage.', code: 'storageLoginRejected' } };
  const f = fixture({ reply: () => refused });
  await f.call('diary', ...LOCAL);
  assert.deepEqual(f.sent.pop(), { status: 424, body: { error: refused.body.detail, code: 'storageLoginRejected' } });
  // No other sidecar field is passed on, and an ordinary failure keeps its old shape.
  const other = fixture({ reply: () => ({ ok: false, status: 500, body: { detail: 'boom', code: 'internal-detail' } }) });
  await other.call('diary', ...LOCAL);
  assert.deepEqual(other.sent.pop(), { status: 500, body: { error: 'boom' } });
  const bare = fixture({ reply: () => ({ ok: false, status: 502, body: null }) });
  await bare.call('diary', ...LOCAL);
  assert.deepEqual(bare.sent.pop(), { status: 502, body: { error: 'Diary storage request failed' } });
});

test('#1168: a storage throttle reaches the browser with its code, wait and Retry-After header', async () => {
  const throttled = { ok: false, status: 503, body: { detail: 'The storage server is limiting sign-ins. Try again in 42 seconds.', code: 'storageThrottled', retryAfter: 41.2 } };
  const f = fixture({ reply: () => throttled });
  await f.call('diary', ...LOCAL);
  assert.deepEqual(f.sent.pop(), { status: 503, body: { error: throttled.body.detail, code: 'storageThrottled', retryAfter: 42 }, headers: { 'Retry-After': '42' } });
  // A missing or nonsense wait is dropped, not invented; the code still passes.
  for (const retryAfter of [undefined, 'soon', -5, 0]) {
    const odd = fixture({ reply: () => ({ ok: false, status: 503, body: { detail: 'wait', code: 'storageThrottled', retryAfter } }) });
    await odd.call('diary', ...LOCAL);
    assert.deepEqual(odd.sent.pop(), { status: 503, body: { error: 'wait', code: 'storageThrottled' } }, String(retryAfter));
  }
  // The wait is capped so a hostile sidecar value cannot become a day-long header.
  const huge = fixture({ reply: () => ({ ok: false, status: 503, body: { detail: 'wait', code: 'storageThrottled', retryAfter: 1e9 } }) });
  await huge.call('diary', ...LOCAL);
  assert.equal(huge.sent.pop().headers['Retry-After'], '86400');
});

test('#1168: X-Cowork-Storage-Retry: 1 never reaches the sidecar from the local exchange, and nothing is logged for it', async () => {
  // A retry press is a file-list action, and the file lists are the Rust front's now
  // (noevia-rs crates/server-diary/tests/proxy_parity.rs:131).
  const lines = [];
  const f = fixture({ log: (line) => lines.push(line) });
  await f.call('diary', ...LOCAL, { reqHeaders: { 'x-cowork-storage-retry': '1' } });
  assert.equal(f.sent.pop().status, 200);
  assert.equal('X-Cowork-Storage-Retry' in f.fetched.pop().init.headers, false);
  assert.deepEqual(lines, []);
});

// sbstndalton/noevia#2232: a Diary that cannot be reached (the network call fails) is a 503 the page can
// word, with a stable code and no address or error text; it used to reach http.cjs as a bare 500. Only a
// network or abort failure is "unavailable": a redirect (fetchJson uses redirect:'error') or a failure while
// building the tenant headers is a bug and stays a 500, and is logged by class.
const refused = (code = 'ECONNREFUSED') => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(`connect ${code} 10.1.2.3:8010`), { code, address: '10.1.2.3' }) });

test('#2232: an unreachable Diary answers 503 diaryUnavailable on the Node-owned Diary route', async () => {
  const unavailable = { status: 503, body: { error: 'Diary is unavailable right now. Try again shortly.', code: 'diaryUnavailable' } };
  // EAI_AGAIN (the resolver is down while the sidecar restarts) has an underscore: #2245.
  for (const reply of [() => { throw refused(); }, () => { throw refused('EAI_AGAIN'); }, () => { throw refused('ENOTFOUND'); }, () => { throw Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' }); }]) {
    const lines = [];
    const f = fixture({ admin: true, reply, log: (l) => lines.push(l) });
    assert.equal(await f.call('diary', ...LOCAL), true);
    const answered = f.sent.pop();
    assert.deepEqual(answered, unavailable);
    assert.doesNotMatch(JSON.stringify(answered), /10\.1\.2\.3|ECONN|EAI_|ENOTFOUND|fetch failed/);
    assert.ok(lines.length > 0 && lines.every((l) => /unavailable/.test(l) && !/10\.1\.2\.3/.test(l)), 'logged by class');
  }
});

// noevia#2252 (review of core#294): the code pattern also matched every ERR_* code, so a bad DIARY_BASE
// (ERR_INVALID_URL) or a TLS fault read as "unavailable". Socket and resolver codes only.
test('#2252: ERR_* codes (a bad DIARY_BASE, a TLS fault) stay internal; socket, resolver and undici codes are unavailable', async () => {
  for (const code of ['ERR_INVALID_URL', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_SSL_WRONG_VERSION_NUMBER', 'ERR_INVALID_ARG_TYPE']) {
    const lines = [];
    const f = fixture({ reply: () => { throw refused(code); }, log: (l) => lines.push(l) });
    await assert.rejects(f.call('diary', ...LOCAL), /fetch failed/, code);
    assert.equal(f.sent.length, 0, code);
    assert.match(lines[0], /\(internal\)/, code);
  }
  for (const code of ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'EAI_NODATA', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'ERR_SOCKET_CONNECTION_TIMEOUT']) {
    const f = fixture({ reply: () => { throw refused(code); } });
    assert.equal(await f.call('diary', ...LOCAL), true, code);
    assert.equal(f.sent.pop().status, 503, code);
  }
});

test('#2232: a redirect or a failure building the tenant headers is not "unavailable"', async () => {
  const redirect = () => { throw Object.assign(new TypeError('fetch failed'), { cause: new Error('unexpected redirect') }); };
  const lines = [];
  const f = fixture({ reply: redirect, log: (l) => lines.push(l) });
  await assert.rejects(f.call('diary', ...LOCAL), /fetch failed/);
  assert.equal(f.sent.length, 0);
  assert.match(lines[0], /TypeError.*\(internal\)/);
  // The tenant headers carry the storage secret, so a failure while building them must reach neither the
  // log nor the browser: it is thrown from diaryHeaders itself, and answered by the server's last-resort
  // handler (index.cjs uiHandler -> http.cjs answerUnhandled) as a generic 500.
  const SECRET = 'storage row unreadable /srv/secret synthetic-pw';
  const g = fixture({ diaryHeaders: () => { throw new Error(SECRET); }, log: (l) => lines.push(l) });
  const err = await g.call('diary', ...LOCAL).then(() => null, (e) => e);
  assert.ok(err && err.message === SECRET, 'the header failure propagates as an internal error');
  assert.equal(g.sent.length, 0);
  assert.equal(g.fetched.length, 0, 'nothing is sent without its tenant headers');
  let status, text = '';
  const res = { writeHead: (code) => { status = code; }, end: (body) => { text += body; } };
  require('../http.cjs').answerUnhandled(res, err, () => {});
  assert.equal(status, 500);
  assert.deepEqual(JSON.parse(text), { error: 'Internal error' });
  assert.ok(!text.includes('/srv/secret') && !text.includes('synthetic-pw') && !text.includes('storage row'), 'the message is not in the response');
  assert.ok(lines.every((l) => !l.includes('/srv/secret') && !l.includes('synthetic-pw')), 'nor in the route\'s log');
});
