'use strict';
// #1406 / #1419 / #1420: the chat-list saves answer with the right status. 400 only for a bad request;
// a busy store is 503 (with Retry-After); a disk failure is 500. A free-chat list that holds null reads
// as an empty list and answers cleanly. Synthetic chats only; the store is a fake that fails on demand.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { AsyncLocalStorage } = require('node:async_hooks');
const { saveFailureReply } = require('./http.cjs');
const { createChatListRoutes } = require('./routes/chat-lists.cjs');
const { createProjectRoutes } = require('./routes/projects.cjs');

const CHAT = { id: 'chat-a', title: 'Synthetic chat', updatedAt: 1, preview: '' };
const busy = () => Object.assign(new Error('The project store is busy. Try again shortly.'), { status: 503, code: 'PROJECTS_BUSY' });

function readBodyFrom(text) {
  return async () => text;
}

function freeChatRoutes({ body, saveFreeChats = () => {}, freeChats = [] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-1406-'));
  const sent = [];
  const routes = createChatListRoutes({
    json: (res, status, payload, headers) => { sent.push({ status, body: payload, headers }); },
    readBody: readBodyFrom(body),
    currentWorkspace: () => ({ dir, userId: 'u1' }),
    PROJECTS: [], FREE_CHATS: freeChats, diaryExtras: { internalProject: () => false },
    crypto: require('node:crypto'), STORED_HISTORY_BYTES: 1e6, STORED_HISTORY_CAP: 100,
    chatLists: () => ({ freeChats: [], projects: [] }), removeChat() {},
    store: { sanitizeChats: (c) => (c || []).filter((x) => x && typeof x === 'object'), saveFreeChats, deleteFreeChat: () => false, readHistory: () => [], writeHistory() {}, moveChat() {} },
  });
  const call = (method, p, extra = {}) => {
    const req = Readable.from([]);
    req.method = method;
    return routes(req, {}, { path: p, authn: { user: { id: 'u1', role: 'member' } }, ...extra }).then(() => sent.at(-1));
  };
  return { call, sent, dir };
}

test('#1419: a busy store on a free-chat save is 503 with Retry-After, not a 400 "invalid JSON"', async (t) => {
  const f = freeChatRoutes({ body: JSON.stringify({ chats: [CHAT] }), saveFreeChats: () => { throw busy(); } });
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  const reply = await f.call('POST', '/api/freechats');
  assert.equal(reply.status, 503);
  assert.equal(reply.body.code, 'PROJECTS_BUSY');
  assert.deepEqual(reply.headers, { 'Retry-After': '1' });
});

test('#1419: a disk failure on a free-chat save is 500, and the message names no path or internal', async (t) => {
  const f = freeChatRoutes({ body: JSON.stringify({ chats: [CHAT] }), saveFreeChats: () => { throw Object.assign(new Error('EACCES: /secret/path/free-chats.json'), { code: 'EACCES' }); } });
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  const reply = await f.call('POST', '/api/freechats');
  assert.equal(reply.status, 500);
  assert.equal(JSON.stringify(reply.body).includes('/secret/path'), false);
});

test('#1419: only a request that cannot be read is a 400 on the free-chat save', async (t) => {
  for (const [body, error] of [['not json', 'invalid JSON'], ['null', 'chats array required'], ['{"chats":"x"}', 'chats array required'], ['[]', 'chats array required']]) {
    const f = freeChatRoutes({ body });
    t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
    const reply = await f.call('POST', '/api/freechats');
    assert.equal(reply.status, 400, body);
    assert.equal(reply.body.error, error, body);
  }
});

test('#1420: a free-chat list holding null reads as an empty list, with a clean 200', async (t) => {
  const f = freeChatRoutes({ body: '', freeChats: null });
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  const reply = await f.call('GET', '/api/freechats');
  assert.equal(reply.status, 500, 'a list that cannot be read is a clean 500, never a broken response');
  assert.equal(typeof reply.body.error, 'string');
  const ok = freeChatRoutes({ body: '', freeChats: [CHAT] });
  t.after(() => fs.rmSync(ok.dir, { recursive: true, force: true }));
  const fine = await ok.call('GET', '/api/freechats');
  assert.deepEqual(fine.body, { chats: [CHAT] });
});

test('#1420: the workspace loads a free-chats file that holds null as an empty list', () => {
  const { createWorkspaceStore } = require('./workspace.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-1420-'));
  try {
    const userId = '11111111-2222-4333-8444-666666666666';
    fs.mkdirSync(path.join(root, 'users', userId), { recursive: true });
    fs.writeFileSync(path.join(root, 'users', userId, 'free-chats.json'), 'null');
    const workspace = createWorkspaceStore(root, { id: 'default', label: 'Default', apiKey: '' }).get(userId);
    assert.deepEqual(Array.from(workspace.freeChats), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('#1406: a project chat-list save maps a busy store to 503 and a bad body to 400', async (t) => {
  const sent = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-1406p-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const project = { id: 'p1', name: 'P', files: [], assets: [], chats: [] };
  let mode = 'busy';
  const routes = createProjectRoutes({
    json: (res, status, body, headers) => { sent.push({ status, body, headers }); },
    readBody: async (req) => { let s = ''; for await (const c of req) s += c; return s; },
    readJson: require('./http.cjs').readJson, requestScope: new AsyncLocalStorage(), dispatch: async () => {},
    currentWorkspace: () => ({ dir, userId: 'u1', assertActive() {} }),
    authService: { getStorage: () => ({ kind: 'local' }) }, storageClient: { isBrowsable: () => false }, documents: { isDocument: () => false }, documentSources: {},
    rag: {}, fs, path, reasoningEffort: {}, projectAppearance: () => ({}), diaryExtras: { PROJECT_ID: 'diary-extras', internalProject: () => false },
    PROJECTS: [project], DEFAULT_TOOLBOXES: ['core'], sanitizeToolboxes: (b) => b, getProvider: () => ({}), ensureRolesLoaded() {}, servedCatalogue: async () => null, DEFAULT_PROVIDER_ID: 'default',
    store: {
      getProject: (id) => (id === 'p1' ? project : null), saveProjects() {}, pruneDocuments() {}, withSourceLock: (_p, op) => op(), indexSource() {}, ownsFile: () => false,
      loadChats: () => [], deleteChat: () => false,
      saveChats: () => { if (mode === 'busy') throw busy(); if (mode === 'disk') throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); return []; },
    },
  });
  const post = (text) => {
    const req = Readable.from([Buffer.from(text)]);
    Object.assign(req, { method: 'POST', url: '/api/projects/p1/chats', headers: {}, socket: {} });
    return routes(req, {}, { path: '/api/projects/p1/chats', authn: { user: { id: 'u1', role: 'member' } }, url: new URL('http://localhost/api/projects/p1/chats') }).then(() => sent.at(-1));
  };
  const good = JSON.stringify({ chats: [CHAT] });
  assert.equal((await post(good)).status, 503);
  mode = 'disk';
  assert.equal((await post(good)).status, 500);
  mode = 'ok';
  assert.equal((await post(good)).status, 200);
  assert.equal((await post('nope')).status, 400);
  assert.equal((await post('null')).status, 400);
  assert.equal((await post('{"chats":1}')).status, 400);
});

test('saveFailureReply: a 4xx the store chose is kept, and a 400 is never used for a failed save', () => {
  const seen = [];
  const send = (res, code, body, headers) => seen.push({ code, body, headers });
  saveFailureReply(send, {}, Object.assign(new Error('gone'), { status: 410 }));
  assert.equal(seen[0].code, 410, 'a status the store chose (a retired account) is kept');
  seen.length = 0;
  saveFailureReply(send, {}, Object.assign(new Error('bad'), { status: 400 }));
  assert.equal(seen[0].code, 500, 'a 400 from a failed save becomes 500');
  seen.length = 0;
  saveFailureReply(send, {}, busy());
  assert.equal(seen[0].code, 503);
  assert.deepEqual(seen[0].headers, { 'Retry-After': '1' });
  assert.equal(seen[0].body.code, 'PROJECTS_BUSY');
  seen.length = 0;
  saveFailureReply(send, {}, new Error('EACCES /x'), 'could not save; nothing was changed');
  assert.equal(seen[0].code, 500);
  assert.equal(JSON.stringify(seen[0].body).includes('EACCES'), false);
});
