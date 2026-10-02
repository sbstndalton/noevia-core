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

test('a late history save for a deleted chat does not write the transcript back', async () => {
  await post('/api/freechats', { chats: [meta('c-deleted-while-streaming')] });
  await post('/api/chats/c-deleted-while-streaming/history', { history: [{ role: 'user', content: 'first' }] });
  assert.equal((await request('/api/freechats/c-deleted-while-streaming', { method: 'DELETE', headers: mutationHeaders() })).status, 200);
  const late = await post('/api/chats/c-deleted-while-streaming/history', { history: [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'late reply' }] });
  assert.equal(late.status, 410);
  const read = JSON.parse((await request('/api/chats/c-deleted-while-streaming/history', { headers: mutationHeaders() })).text).history;
  assert.deepEqual(read, []);
});

// Chat framing, phase 2 (#738): what the confirm row writes reaches storage, and the move path.
const frame = (extra = {}) => ({ projectId: null, kind: 'idea', tags: ['plans'], links: [], confirmed: true, source: 'user', ...extra });
const freeMeta = async (id) => JSON.parse((await request('/api/freechats', { headers: mutationHeaders() })).text).chats.find((c) => c.id === id);

test('list saves keep a frame and createdAt; frame null clears it and an older tab cannot erase it (#738)', async () => {
  await post('/api/freechats', { chats: [{ ...meta('c-framed'), createdAt: 500, frame: frame() }] });
  assert.deepEqual((await freeMeta('c-framed')).frame, frame());
  assert.equal((await freeMeta('c-framed')).createdAt, 500);
  await post('/api/freechats', { chats: [{ ...meta('c-framed', 'Older tab'), createdAt: 900 }] });
  assert.deepEqual((await freeMeta('c-framed')).frame, frame(), 'a meta without a frame keeps the stored one');
  assert.equal((await freeMeta('c-framed')).createdAt, 500, 'createdAt is set once');
  await post('/api/freechats', { chats: [{ ...meta('c-framed'), frame: null }] });
  assert.ok(!(await freeMeta('c-framed')).frame, 'frame: null clears it');
  const project = JSON.parse((await post('/api/projects', { name: 'Synthetic framed' })).text);
  await post(`/api/projects/${project.id}/chats`, { chats: [{ ...meta('p-framed'), frame: frame({ projectId: project.id }) }] });
  const stored = JSON.parse((await request(`/api/projects/${project.id}/chats`, { headers: mutationHeaders() })).text).chats.find((c) => c.id === 'p-framed');
  assert.deepEqual(stored.frame, frame({ projectId: project.id }));
});

test('accepting a frame moves the chat into the project with its frame; the transcript stays readable (#738)', async () => {
  const project = JSON.parse((await post('/api/projects', { name: 'Synthetic destination' })).text);
  await post('/api/freechats', { chats: [meta('c-moving', 'Moving chat')] });
  await post('/api/chats/c-moving/history', { history: [{ role: 'user', content: 'synthetic first message' }] });
  const moved = await post('/api/chats/c-moving/move', { projectId: project.id, frame: frame({ projectId: project.id }) });
  assert.equal(moved.status, 200);
  assert.deepEqual(JSON.parse(moved.text), { ok: true, from: null, projectId: project.id });
  assert.ok(!(await freeMeta('c-moving')), 'gone from the free list');
  const inProject = JSON.parse((await request(`/api/projects/${project.id}/chats`, { headers: mutationHeaders() })).text).chats.find((c) => c.id === 'c-moving');
  assert.equal(inProject.title, 'Moving chat');
  assert.deepEqual(inProject.frame, frame({ projectId: project.id }));
  const history = JSON.parse((await request('/api/chats/c-moving/history', { headers: mutationHeaders() })).text).history;
  assert.deepEqual(history, [{ role: 'user', content: 'synthetic first message' }]);
  // Moving it back out, and accepting in place (same list), both work without a tombstone.
  assert.equal((await post('/api/chats/c-moving/move', { projectId: null })).status, 200);
  assert.ok(await freeMeta('c-moving'));
  assert.equal((await post('/api/chats/c-moving/move', { projectId: null, frame: frame() })).status, 200);
  assert.deepEqual((await freeMeta('c-moving')).frame, frame());
});

test('the move refuses unknown, deleted and malformed targets without changing anything (#738)', async () => {
  await post('/api/freechats', { chats: [meta('c-stays')] });
  assert.equal((await post('/api/chats/c-stays/move', { projectId: 'no-such-project' })).status, 404);
  assert.ok(await freeMeta('c-stays'), 'still in the free list after a refused move');
  assert.equal((await post('/api/chats/no-such-chat/move', { projectId: null })).status, 404);
  assert.equal((await post('/api/chats/c-stays/move', { projectId: 7 })).status, 400);
  assert.equal((await post('/api/chats/c-stays/move', {})).status, 400);
  assert.equal((await request('/api/freechats/c-stays', { method: 'DELETE', headers: mutationHeaders() })).status, 200);
  assert.equal((await post('/api/chats/c-stays/move', { projectId: null })).status, 404, 'a deleted chat cannot be moved back to life');
  assert.equal((await request('/api/chats/c-stays/move', { method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json' }, body: JSON.stringify({ projectId: null }) })).status >= 401, true, 'signed out (no session, no CSRF) is refused');
});

test('auto-accept chat frames is a per-user preference, off by default (#738, #740)', async () => {
  const get = async () => JSON.parse((await request('/api/chat-framing/preferences', { headers: mutationHeaders() })).text);
  const prefs = (autoAccept, keepReasoningTraces = false) => ({ autoAccept, keepReasoningTraces });
  assert.deepEqual(await get(), prefs(false));
  const put = (body) => request('/api/chat-framing/preferences', { method: 'PUT', headers: mutationHeaders(), body: JSON.stringify(body) });
  assert.equal((await put({ autoAccept: true })).status, 200);
  assert.deepEqual(await get(), prefs(true));
  assert.equal((await put({ autoAccept: 'yes' })).status, 400);
  assert.deepEqual(await get(), prefs(true), 'an invalid value changes nothing');
  assert.equal((await put({ keepReasoningTraces: true })).status, 200);
  assert.deepEqual(await get(), prefs(true, true), 'a partial update keeps the other choice');
  assert.equal((await put({ autoAccept: false })).status, 200);
  assert.deepEqual(await get(), prefs(false, true));
});
