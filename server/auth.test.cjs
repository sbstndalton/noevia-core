'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const test = require('node:test');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-auth-test-'));
process.env.DIARY_AUTH_TOKEN = 'test-cowork-token';
process.env.UI_DATA_DIR = testDataDir;
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

test.before(async () => {
  const setupCode = fs.readFileSync(path.join(testDataDir, 'first-run-setup-code'), 'utf8').trim();
  const response = await request('/api/setup/complete', {
    method: 'POST', headers: { origin: 'http://localhost' },
    body: JSON.stringify({ setupCode, publicOrigin: 'http://localhost', username: 'admin', displayName: 'Admin', password: 'correct horse battery staple' }),
  });
  assert.equal(response.status, 201);
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

test('protects provider creation with the same API guard', async () => {
  const denied = await request('/api/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'Untrusted', baseUrl: 'https://example.invalid/v1' }),
  });
  assert.equal(denied.status, 401);

  const allowed = await request('/api/providers', {
    method: 'POST',
    headers: {
      authorization: 'Bearer test-cowork-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ label: 'Trusted test', baseUrl: 'https://example.invalid/v1' }),
  });
  assert.equal(allowed.status, 200);
});

test('does not require auth for the static application shell', async () => {
  const response = await request('/');
  assert.notEqual(response.status, 401);
});

const adminHeaders = { authorization: 'Bearer test-cowork-token', 'content-type': 'application/json' };

test('provider DELETE removes private and shared providers through the real route', async () => {
  for (const shared of [false, true]) {
    const created = await request('/api/providers', {method:'POST', headers:adminHeaders, body:JSON.stringify({label:'Disposable', baseUrl:'https://example.invalid', shared})});
    const id = JSON.parse(created.text).id;
    assert.ok(id);
    const deleted = await request(`/api/providers/${id}`, {method:'DELETE', headers:adminHeaders});
    assert.equal(deleted.status, 200);
    const listed = await request('/api/providers', {headers:adminHeaders});
    assert.ok(!JSON.parse(listed.text).providers.some(p => p.id === id));
  }
});

test('chat reports upstream errors in SSE without writing headers twice', async (t) => {
  const project = await request('/api/projects', {method:'POST', headers:adminHeaders, body:JSON.stringify({name:'Failure test', model:'model'})});
  const projectId = JSON.parse(project.text).id;
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
  const created = await request('/api/projects', {method:'POST', headers:adminHeaders, body:JSON.stringify({name:'Stream test', model:'model'})});
  const projectId = JSON.parse(created.text).id;
  let calls = 0;
  t.mock.method(global, 'fetch', async (_url, opts) => {
    assert.equal(opts.redirect, 'error');
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
  const result = await request('/api/projects', {method:'POST', headers:adminHeaders, body:'x'.repeat(1024*1024+1)});
  assert.equal(result.status, 413);
});

test('diary file routes require auth and forward conflicts without losing the error', async (t) => {
  assert.equal((await request('/api/diary/files')).status, 401);
  assert.equal((await request('/api/profile/features', { method: 'PUT', headers: adminHeaders, body: JSON.stringify({diaryEnabled:true}) })).status, 200);
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
