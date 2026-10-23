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
let userId = '';
test.before(async () => {
  // Sign-in is the Rust front's (#1071): the account and its session are seeded directly.
  ({ cookie, csrf, id: userId } = require('../tests/server/seed-account.cjs').seedAccount(testDataDir, { username: 'admin', displayName: 'Admin', publicOrigin: 'http://localhost' }));
});

const mutationHeaders = () => ({ origin: 'http://localhost', cookie, 'content-type': 'application/json', 'x-csrf-token': csrf });

const post = (url, body, headers = mutationHeaders()) => request(url, { method: 'POST', headers, body: JSON.stringify(body) });
// #1071 slice 5: a history save is the Rust front's (Node refuses it), in process over the same store.
const saveHistory = (chatId, body) => require('../tests/server/project-store-server.cjs').rustHistorySave(testDataDir, userId, chatId, body);
// #1071 slice 6: a chat's delete is the Rust front's too (Node refuses it), in process over the same store.
const frontDelete = (projectId, chatId) => require('../tests/server/project-store-server.cjs').rustChatDelete(testDataDir, userId, projectId, chatId);
const realFetch = global.fetch;

const meta = (id, title = id, updatedAt = 1000) => ({ id, title, updatedAt, preview: '' });
// The chat-list and free-chat-list saves are the Rust front's (sbstndalton/noevia#1071; their merge
// is noevia-rs crates/server-projects): here the front's write is the file as the front writes it,
// replaced whole, and Node takes it in at the next request start. What Node still does with the
// lists (a delete, a move, a transcript) runs through its own routes; its view is /api/workspace.
const userFile = (name) => path.join(testDataDir, 'users', userId, name);
function frontWrite(file, value) { fs.writeFileSync(`${file}.front`, JSON.stringify(value, null, 2)); fs.renameSync(`${file}.front`, file); }
async function frontSaveFree(metas) {
  await request('/api/workspace', { headers: mutationHeaders() }); // the workspace (and its directory) exists
  let list = [];
  try { list = JSON.parse(fs.readFileSync(userFile('free-chats.json'), 'utf8')) || []; } catch { /* none yet */ }
  for (const m of metas) { const i = list.findIndex((c) => c.id === m.id); if (i >= 0) list[i] = { ...list[i], ...m }; else list.unshift(m); }
  frontWrite(userFile('free-chats.json'), list);
}
const workspace = async () => JSON.parse((await request('/api/workspace', { headers: mutationHeaders() })).text);
const freeChats = async () => (await workspace()).freeChats.map((c) => c.id).sort();
const freeMeta = async (id) => (await workspace()).freeChats.find((c) => c.id === id);
const projectChats = async (projectId) => (await workspace()).projects.find((p) => p.id === projectId).chats;

test('Node refuses the list saves and the deletes the front owns; it follows the front\'s free-chat list and a front delete sticks', async () => {
  for (const [method, url] of [['GET', '/api/freechats'], ['POST', '/api/freechats'], ['GET', '/api/projects/p1/chats'], ['POST', '/api/projects/p1/chats'],
    ['DELETE', '/api/freechats/c-alpha'], ['DELETE', '/api/projects/p1/chats/c1']]) {
    const r = await request(url, { method, headers: mutationHeaders(), body: method === 'POST' ? JSON.stringify({ chats: [meta('c-refused')] }) : '' });
    assert.equal(r.status, 503, `${method} ${url}`);
    assert.equal(JSON.parse(r.text).code, 'RUST_PROJECTS_OWNED');
  }
  await frontSaveFree([meta('c-alpha'), meta('c-bravo')]);
  assert.deepEqual(await freeChats(), ['c-alpha', 'c-bravo']);
  assert.ok(!(await freeChats()).includes('c-refused'));
  assert.equal((await request('/api/freechats/c-alpha', { method: 'DELETE', headers: mutationHeaders() })).status, 503);
  assert.deepEqual(await freeChats(), ['c-alpha', 'c-bravo'], 'the refused delete changed nothing');
  assert.equal(frontDelete(null, 'c-alpha').status, 200);
  assert.deepEqual(await freeChats(), ['c-bravo']);
  assert.deepEqual(JSON.parse(fs.readFileSync(userFile('free-chats.json'), 'utf8')).map((c) => c.id), ['c-bravo'], 'saved through the store');
});

test('a chat the front deleted from a project is gone from Node\'s view and from the project on disk', async () => {
  const project = JSON.parse((await post('/api/projects', { name: 'Synthetic lists' })).text);
  const file = JSON.parse(fs.readFileSync(userFile('projects.json'), 'utf8'));
  file.projects.find((p) => p.id === project.id).chats = [meta('p-one'), meta('p-two')];
  frontWrite(userFile('projects.json'), file);
  assert.deepEqual((await projectChats(project.id)).map((c) => c.id), ['p-one', 'p-two']);
  assert.equal(frontDelete(project.id, 'p-one').status, 200);
  assert.deepEqual((await projectChats(project.id)).map((c) => c.id), ['p-two']);
  const onDisk = JSON.parse(fs.readFileSync(userFile('projects.json'), 'utf8')).projects.find((p) => p.id === project.id).chats.map((c) => c.id);
  assert.deepEqual(onDisk, ['p-two']);
});

test('a late history save for a deleted chat does not write the transcript back', async () => {
  await frontSaveFree([meta('c-deleted-while-streaming')]);
  assert.equal(saveHistory('c-deleted-while-streaming', { history: [{ role: 'user', content: 'first' }] }).status, 200);
  assert.equal(frontDelete(null, 'c-deleted-while-streaming').status, 200);
  const late = saveHistory('c-deleted-while-streaming', { history: [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'late reply' }] });
  assert.equal(late.status, 410);
  // #1071: the GET is the Rust front's; the transcript file is what it would read.
  assert.equal(fs.existsSync(userFile('history-c-deleted-while-streaming.json')), false);
});

// Chat framing, phase 2 (#738): the move path.
const frame = (extra = {}) => ({ projectId: null, kind: 'idea', tags: ['plans'], links: [], confirmed: true, source: 'user', ...extra });

test('accepting a frame moves the chat into the project with its frame; the transcript stays readable (#738)', async () => {
  const project = JSON.parse((await post('/api/projects', { name: 'Synthetic destination' })).text);
  await frontSaveFree([meta('c-moving', 'Moving chat')]);
  assert.equal(saveHistory('c-moving', { history: [{ role: 'user', content: 'synthetic first message' }] }).status, 200);
  const moved = await post('/api/chats/c-moving/move', { projectId: project.id, frame: frame({ projectId: project.id }) });
  assert.equal(moved.status, 200);
  assert.deepEqual(JSON.parse(moved.text), { ok: true, from: null, projectId: project.id });
  assert.ok(!(await freeMeta('c-moving')), 'gone from the free list');
  const inProject = (await projectChats(project.id)).find((c) => c.id === 'c-moving');
  assert.equal(inProject.title, 'Moving chat');
  assert.deepEqual(inProject.frame, frame({ projectId: project.id }));
  // #1071: the GET is the Rust front's; the transcript file is what it reads, and the move leaves it.
  const history = JSON.parse(fs.readFileSync(userFile('history-c-moving.json'), 'utf8')).history;
  assert.deepEqual(history, [{ role: 'user', content: 'synthetic first message' }]);
  // Moving it back out, and accepting in place (same list), both work without a tombstone.
  assert.equal((await post('/api/chats/c-moving/move', { projectId: null })).status, 200);
  assert.ok(await freeMeta('c-moving'));
  assert.equal((await post('/api/chats/c-moving/move', { projectId: null, frame: frame() })).status, 200);
  assert.deepEqual((await freeMeta('c-moving')).frame, frame());
});

test('the move refuses unknown, deleted and malformed targets without changing anything (#738)', async () => {
  await frontSaveFree([meta('c-stays')]);
  assert.equal((await post('/api/chats/c-stays/move', { projectId: 'no-such-project' })).status, 404);
  assert.ok(await freeMeta('c-stays'), 'still in the free list after a refused move');
  assert.equal((await post('/api/chats/no-such-chat/move', { projectId: null })).status, 404);
  assert.equal((await post('/api/chats/c-stays/move', { projectId: 7 })).status, 400);
  assert.equal((await post('/api/chats/c-stays/move', {})).status, 400);
  assert.equal(frontDelete(null, 'c-stays').status, 200);
  assert.equal((await post('/api/chats/c-stays/move', { projectId: null })).status, 404, 'a deleted chat cannot be moved back to life');
  assert.equal((await request('/api/chats/c-stays/move', { method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json' }, body: JSON.stringify({ projectId: null }) })).status >= 401, true, 'signed out (no session, no CSRF) is refused');
});

test('a moved chat is held by its new list exactly once, both ways (#755)', async () => {
  const project = JSON.parse((await post('/api/projects', { name: 'Synthetic stale target' })).text);
  await frontSaveFree([meta('c-stale-f1')]);
  assert.equal((await post('/api/chats/c-stale-f1/move', { projectId: project.id })).status, 200);
  assert.ok(!(await freeChats()).includes('c-stale-f1'), 'the free list does not keep the moved chat');
  assert.deepEqual((await projectChats(project.id)).map((c) => c.id).filter((id) => id === 'c-stale-f1'), ['c-stale-f1'], 'the project holds it exactly once');
  assert.equal((await post('/api/chats/c-stale-f1/move', { projectId: null })).status, 200);
  assert.ok(!(await projectChats(project.id)).some((c) => c.id === 'c-stale-f1'), 'the project list does not keep it');
  assert.ok((await freeChats()).includes('c-stale-f1'), 'back in the free list');
});

test('a move with an invalid frame is refused and keeps the stored frame (#759)', async () => {
  await frontSaveFree([{ ...meta('c-bad-frame'), frame: frame() }]);
  const project = JSON.parse((await post('/api/projects', { name: 'Synthetic bad frame' })).text);
  const res = await post('/api/chats/c-bad-frame/move', { projectId: project.id, frame: { kind: 'bogus' } });
  assert.equal(res.status, 400);
  assert.deepEqual((await freeMeta('c-bad-frame')).frame, frame(), 'still free, frame intact');
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

test('the move never puts a chat into an archived project; a once Code-only project takes it (#810, #1576)', async () => {
  const code = JSON.parse((await post('/api/projects', { name: 'Synthetic code only', modes: ['code'] })).text);
  const archived = JSON.parse((await post('/api/projects', { name: 'Synthetic archived' })).text);
  assert.equal((await post(`/api/projects/${archived.id}/config`, { archived: true })).status, 200);
  await frontSaveFree([meta('c-810')]);
  const refused = await post('/api/chats/c-810/move', { projectId: archived.id, frame: frame({ projectId: archived.id }) });
  assert.equal(refused.status, 404);
  assert.ok(await freeMeta('c-810'), 'still in the free list');
  assert.equal((await post('/api/chats/c-810/move', { projectId: code.id })).status, 200, 'a project saved as Code-only now receives it');
});

test('a malformed chat id in the URL is a 400, not a server error (#812)', async () => {
  for (const [method, url] of [['POST', '/api/chats/%E0%A4/move']]) {
    const r = await request(url, { method, headers: mutationHeaders(), body: method === 'GET' || method === 'DELETE' ? '' : JSON.stringify({ projectId: null, history: [] }) });
    assert.equal(r.status, 400, `${method} ${url}`);
    assert.deepEqual(JSON.parse(r.text), { error: 'invalid chat id' });
  }
  // #1071: the context meter is the Rust front's; Node refuses it before reading the id.
  for (const [method, url] of [['GET', '/api/chats/%E0%A4/context-window'], ['GET', '/api/chats/%E0%A4/history'], ['POST', '/api/chats/%E0%A4/history'],
    ['DELETE', '/api/freechats/%E0%A4'], ['DELETE', '/api/projects/%E0%A4/chats/c1'], ['DELETE', '/api/projects/p1/chats/%E0%A4']]) {
    const owned = await request(url, { method, headers: mutationHeaders(), body: method === 'POST' ? JSON.stringify({ history: [] }) : '' });
    assert.equal(owned.status, 503, `${method} ${url}`);
    assert.equal(JSON.parse(owned.text).code, 'RUST_PROJECTS_OWNED', `${method} ${url}`);
  }
});
