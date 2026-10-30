'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const test = require('node:test');
// #2191 round 2: POST /api/projects is the Rust front's; fixtures are written as its create leaves them.
const { createProjectAs } = require('../tests/server/front-projects.cjs');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-auth-test-'));
process.env.DIARY_AUTH_TOKEN = 'test-cowork-token';
// #294: UI_AUTH_TOKEN no longer falls back to DIARY_AUTH_TOKEN, so the legacy bearer tests below
// need it set explicitly.
process.env.UI_AUTH_TOKEN = 'test-cowork-token';
process.env.UI_DATA_DIR = testDataDir;
// #1071: Node saves projects.json / free-chats.json only through the Rust project store.
require('../tests/server/project-store-server.cjs').installProjectStore(testDataDir);
process.env.LEGACY_AUTH_COMPAT = 'true';
process.env.PUBLIC_ORIGIN = 'http://localhost';

const { handleRequest } = require('./index.cjs');

test.after(() => {
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

async function request(url, { method = 'GET', headers = {}, body = '' } = {}) {
  const req = Readable.from(body ? [body] : []);
  req.url = url;
  req.method = method;
  req.headers = { host: 'localhost', ...headers };

  const chunks = [];
  const responseHeaders = {};
  const res = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  res.statusCode = 200;
  res.headersSent = false;
  res.setHeader = (name, value) => { responseHeaders[name] = value; };
  res.writeHead = (status, nextHeaders = {}) => {
    if (res.headersSent) throw Object.assign(new Error('headers already sent'), {code:'ERR_HTTP_HEADERS_SENT'});
    res.statusCode = status;
    res.headersSent = true;
    Object.assign(responseHeaders, nextHeaders);
    return res;
  };

  const finished = new Promise((resolve, reject) => {
    res.once('finish', resolve);
    res.once('error', reject);
  });
  await handleRequest(req, res);
  await finished;
  return {
    status: res.statusCode,
    headers: responseHeaders,
    text: Buffer.concat(chunks).toString('utf8'),
  };
}

let adminId = '';
test.before(() => {
  // First-run setup is the Rust front's (#1071): the administrator the legacy bearer acts as is seeded.
  ({ id: adminId } = require('../tests/server/seed-account.cjs').seedAccount(testDataDir, { username: 'admin', displayName: 'Admin', publicOrigin: 'http://localhost' }));
});

test('rejects API requests without a token', async () => {
  const response = await request('/api/workspace');
  assert.equal(response.status, 401);
  assert.match(response.headers['WWW-Authenticate'] || '', /^Bearer /);
  assert.deepEqual(JSON.parse(response.text), { error: 'unauthorized' });
});

test('rejects API requests with the wrong token', async () => {
  const response = await request('/api/workspace', {
    headers: { authorization: 'Bearer wrong-token' },
  });
  assert.equal(response.status, 401);
});

test('accepts a valid bearer token', async () => {
  const response = await request('/api/workspace', {
    headers: { authorization: 'Bearer test-cowork-token' },
  });
  assert.equal(response.status, 200);
  const body = JSON.parse(response.text);
  assert.ok(Array.isArray(body.projects));
});

test('provider creation is the Rust front\'s: Node refuses it before authentication and creates nothing', async () => {
  // The same API guard (401 signed out, then the shared and address rules) is asserted where the
  // route lives: noevia-rs tests/providers.rs. Node's mount cannot be reached by a stale route table.
  for (const headers of [{ 'content-type': 'application/json' }, { authorization: 'Bearer test-cowork-token', 'content-type': 'application/json' }]) {
    const refused = await request('/api/providers', { method: 'POST', headers, body: JSON.stringify({ label: 'Untrusted', baseUrl: 'https://example.invalid/v1' }) });
    assert.equal(refused.status, 503);
    assert.equal(JSON.parse(refused.text).code, 'RUST_PROVIDERS_OWNED');
  }
});

test('does not require auth for the static application shell', async () => {
  const response = await request('/');
  assert.notEqual(response.status, 401);
});

const adminHeaders = { authorization: 'Bearer test-cowork-token', 'content-type': 'application/json' };

test('the provider registry\'s other methods are refused too (the Rust front removes and edits rows)', async () => {
  for (const [method, url] of [['GET', '/api/providers'], ['PUT', '/api/providers/p1'], ['DELETE', '/api/providers/p1'], ['DELETE', '/api/providers/chatgpt']]) {
    const refused = await request(url, { method, headers: adminHeaders, body: method === 'PUT' ? '{}' : '' });
    assert.equal(refused.status, 503, `${method} ${url}`);
    assert.equal(JSON.parse(refused.text).code, 'RUST_PROVIDERS_OWNED');
  }
});

test('chat reports upstream errors in SSE without writing headers twice', async (t) => {
  const projectId = createProjectAs(testDataDir, adminId, {name:'Failure test', model:'model'}).id;
  for (const fetchStub of [async () => { throw new Error('offline'); }, async () => new Response('unavailable', {status:503})]) {
    t.mock.method(global, 'fetch', fetchStub);
    const result = await request('/api/chat', {method:'POST', headers:adminHeaders, body:JSON.stringify({projectId, chatId:'test', message:'hello'})});
    assert.equal(result.status, 200);
    assert.match(result.text, /"type":"error"/);
    assert.match(result.text, /"type":"done"/);
    t.mock.restoreAll();
  }
});

test('empty SSE fallback refuses redirects and reconstructs split SSE lines', async (t) => {
  const projectId = createProjectAs(testDataDir, adminId, {name:'Stream test', model:'model'}).id;
  let calls = 0;
  t.mock.method(global, 'fetch', async (_url, opts) => {
    assert.equal(opts.redirect, 'error');
    // #1785: the title request after a first reply is its own call, not part of the stream and its fallback.
    if (JSON.parse(opts.body).messages?.[0]?.content === require('./chat-title.cjs').TITLE_SYSTEM) return Response.json({choices:[{message:{content:'Stream Test'}}]});
    calls++;
    return calls === 1 ? new Response('') : Response.json({choices:[{message:{content:'fallback answer'}}]});
  });
  const result = await request('/api/chat', {method:'POST', headers:adminHeaders, body:JSON.stringify({projectId, chatId:'test', message:'hello'})});
  assert.equal(calls, 2);
  assert.match(result.text, /fallback answer/);
  t.mock.restoreAll();
  t.mock.method(global, 'fetch', async () => new Response(new ReadableStream({start(controller) {
    const line = 'data: '+JSON.stringify({choices:[{delta:{content:'split answer'}}]})+'\n\n';
    controller.enqueue(new TextEncoder().encode(line.slice(0, 17)));
    controller.enqueue(new TextEncoder().encode(line.slice(17))); controller.close();
  }})));
  const split = await request('/api/chat', {method:'POST', headers:adminHeaders, body:JSON.stringify({projectId, chatId:'test', message:'hello'})});
  assert.match(split.text, /split answer/);
});

test('large authenticated request is bounded before JSON parsing', async () => {
  // POST /api/projects is the Rust front's (#2191 round 2); the config route reads with the same default cap.
  const result = await request('/api/projects/p1/config', {method:'POST', headers:adminHeaders, body:'x'.repeat(1024*1024+1)});
  assert.equal(result.status, 413);
});

test('diary file routes require auth and forward conflicts without losing the error', async (t) => {
  assert.equal((await request('/api/diary/files')).status, 401);
  // The Diary preference is written by the Rust front (#1071).
  require('../tests/server/seed-account.cjs').setUserFeatures(testDataDir, adminId, { diaryEnabled: true });
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    assert.match(String(url), /\/api\/file$/);
    assert.ok(opts.headers['X-Cowork-User-ID']);
    assert.equal(opts.redirect, 'error');
    return Response.json({ detail: 'File changed elsewhere' }, { status: 409 });
  });
  const r = await request('/api/diary/file', { method: 'PUT', headers: adminHeaders, body: JSON.stringify({path:'MEMORY.md',content:'edited',version:'old'}) });
  assert.equal(r.status,409);assert.match(r.text,/changed elsewhere/);
});
test('diary forwards browser date and selected day to the pipeline', async (t) => {
  let sent;
  t.mock.method(globalThis, 'fetch', async (_url, opts) => {
    sent = JSON.parse(opts.body);
    return Response.json({ choices:[{message:{content:'Reply',reasoning_content:'Synthetic provider reasoning'}}], diary:{decision:'logged'} });
  });
  const r = await request('/api/chat', { method:'POST',headers:adminHeaders,body:JSON.stringify({spaceId:'diary',message:'Past day note',history:[],entryTime:'2026-09-07T10:00:00-04:00',entryDay:'2026-07-08'}) });
  assert.equal(r.status,200);assert.equal(sent.entryDay,'2026-07-08');assert.equal(sent.entryTime,'2026-09-07T10:00:00-04:00');
  assert.match(r.text, /"type":"reasoning","text":"Synthetic provider reasoning"/);
});

// The profile, the Diary preference and appearance are the Rust front's (#1071; noevia-rs crates/server-account).
