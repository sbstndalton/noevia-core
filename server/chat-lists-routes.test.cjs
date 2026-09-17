'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const test = require('node:test');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-chat-lists-route-test-'));
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

const meta = (id, title = id, updatedAt = 1000) => ({ id, title, updatedAt, preview: '' });
const freeChats = async () => JSON.parse((await request('/api/freechats', { headers: mutationHeaders() })).text).chats.map((c) => c.id).sort();

test('saving a stale free-chat list keeps chats another tab created, and never resurrects a deleted one', async () => {
  assert.equal((await post('/api/freechats', { chats: [meta('c-alpha')] })).status, 200);
  assert.equal((await post('/api/freechats', { chats: [meta('c-bravo')] })).status, 200, 'a tab that never saw alpha');
  assert.deepEqual(await freeChats(), ['c-alpha', 'c-bravo']);
  await post('/api/freechats', { chats: [meta('c-alpha', 'Renamed alpha', 2000)] });
  const renamed = JSON.parse((await request('/api/freechats', { headers: mutationHeaders() })).text).chats.find((c) => c.id === 'c-alpha');
  assert.equal(renamed.title, 'Renamed alpha');
  assert.equal((await request('/api/freechats/c-alpha', { method: 'DELETE', headers: mutationHeaders() })).status, 200);
  await post('/api/freechats', { chats: [meta('c-alpha'), meta('c-bravo')] });
  assert.deepEqual(await freeChats(), ['c-bravo'], 'a stale list must not bring a deleted chat back');
});

test('project chat lists merge the same way', async () => {
  const project = JSON.parse((await post('/api/projects', { name: 'Synthetic lists' })).text);
  await post(`/api/projects/${project.id}/chats`, { chats: [meta('p-one')] });
  await post(`/api/projects/${project.id}/chats`, { chats: [meta('p-two')] });
  const ids = async () => JSON.parse((await request(`/api/projects/${project.id}/chats`, { headers: mutationHeaders() })).text).chats.map((c) => c.id).sort();
  assert.deepEqual(await ids(), ['p-one', 'p-two']);
  assert.equal((await request(`/api/projects/${project.id}/chats/p-one`, { method: 'DELETE', headers: mutationHeaders() })).status, 200);
  await post(`/api/projects/${project.id}/chats`, { chats: [meta('p-one'), meta('p-two')] });
  assert.deepEqual(await ids(), ['p-two']);
});
