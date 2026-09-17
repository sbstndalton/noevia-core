'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const test = require('node:test');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-project-modes-route-test-'));
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
  return { status: res.statusCode, headers: responseHeaders, text: Buffer.concat(chunks).toString('utf8'), bytes: Buffer.concat(chunks) };
}

let cookie = '';
let csrf = '';
test.before(async () => {
  const setupCode = fs.readFileSync(path.join(testDataDir, 'first-run-setup-code'), 'utf8').trim();
  const setup = await request('/api/setup/complete', {
    method: 'POST', headers: { origin: 'http://localhost' },
    body: JSON.stringify({ setupCode, publicOrigin: 'http://localhost', username: 'admin', displayName: 'Admin', password: 'correct horse battery staple' }),
  });
  assert.equal(setup.status, 201);
  const login = await request('/api/auth/login/password', {
    method: 'POST', headers: { origin: 'http://localhost' },
    body: JSON.stringify({ username: 'admin', password: 'correct horse battery staple' }),
  });
  assert.equal(login.status, 200);
  const setCookies = login.headers['set-cookie'] || login.headers['Set-Cookie'] || [];
  cookie = setCookies.map((c) => c.split(';')[0]).join('; ');
  assert.ok(cookie, 'login must set a session cookie');
  const csrfPair = setCookies.map((c) => c.split(';')[0]).find((c) => c.startsWith('cowork_csrf='));
  assert.ok(csrfPair, 'login must set the CSRF cookie');
  csrf = decodeURIComponent(csrfPair.split('=').slice(1).join('='));
});

const mutationHeaders = () => ({ origin: 'http://localhost', cookie, 'content-type': 'application/json', 'x-csrf-token': csrf });

const post = (url, body, headers = mutationHeaders()) => request(url, { method: 'POST', headers, body: JSON.stringify(body) });
const realFetch = global.fetch;
test.before(() => { global.fetch = async () => { throw new Error('Unexpected network in project modes route test'); }; });
test.after(() => { global.fetch = realFetch; });

test('projects default to Chat, accept valid modes and reject invalid ones', async () => {
  const plain = JSON.parse((await post('/api/projects', { name: 'Synthetic default' })).text);
  assert.deepEqual(plain.modes, ['chat']);
  const code = JSON.parse((await post('/api/projects', { name: 'Synthetic C++', modes: ['code'] })).text);
  assert.deepEqual(code.modes, ['code']);
  assert.equal((await post('/api/projects', { name: 'Bad', modes: [] })).status, 400);
  assert.equal((await post('/api/projects', { name: 'Bad', modes: ['voice'] })).status, 400);
  const patched = await post(`/api/projects/${plain.id}/config`, { modes: ['code', 'chat', 'cowork'] });
  assert.equal(patched.status, 200);
  const workspace = JSON.parse((await request('/api/workspace', { headers: mutationHeaders() })).text);
  assert.deepEqual(workspace.projects.find((p) => p.id === plain.id).modes, ['chat', 'cowork', 'code']);
  assert.equal((await post(`/api/projects/${plain.id}/config`, { modes: [] })).status, 400);
  assert.deepEqual(JSON.parse((await request('/api/workspace', { headers: mutationHeaders() })).text).projects.find((p) => p.id === plain.id).modes, ['chat', 'cowork', 'code']);
});

test('a project not enabled for Chat refuses chat before any inference call', async () => {
  const code = JSON.parse((await post('/api/projects', { name: 'Synthetic code only', modes: ['code'] })).text);
  let calls = 0; const previous = global.fetch;
  global.fetch = async () => { calls++; throw new Error('no inference expected'); };
  try {
    const reply = await post('/api/chat', { spaceId: 'project', projectId: code.id, message: 'hello', history: [] });
    assert.equal(reply.status, 409);
    assert.match(JSON.parse(reply.text).error, /not enabled for Chat/);
    assert.equal(calls, 0);
  } finally { global.fetch = previous; }
});
