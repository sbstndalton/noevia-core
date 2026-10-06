'use strict';

// Review-finding regressions for the server: error bodies, non-object JSON, chat-id
// sanitizing against tombstones, empty ids, and the write-approval gate's scoping.
// Synthetic ids and fakes only; nothing here boots the server.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { errorResponse, isJsonObject } = require('../../server/http.cjs');
const { createApprovals } = require('../../server/approvals.cjs');
const { createApprovalRoutes } = require('../../server/routes/approvals.cjs');
const { createChatRoutes } = require('../../server/routes/chat.cjs');
const { createChatListRoutes } = require('../../server/routes/chat-lists.cjs');
const lists = require('../../server/chat-lists.cjs');

function recorder() {
  const out = {};
  return { out, json: (_res, status, body) => { out.status = status; out.body = body; return true; } };
}

test('S1: internal errors get a generic body; client errors keep their message', () => {
  assert.deepEqual(errorResponse(new Error('ENOENT /data/secret/path')), { status: 500, body: { error: 'Internal error' } });
  assert.deepEqual(errorResponse(Object.assign(new Error('db exploded at /x'), { status: 502 })), { status: 502, body: { error: 'Internal error' } });
  assert.deepEqual(errorResponse(Object.assign(new Error('too big'), { status: 413 })), { status: 413, body: { error: 'too big' } });
  assert.deepEqual(errorResponse('a thrown string'), { status: 500, body: { error: 'Internal error' } });
});

test('S2: JSON null, arrays and scalars are not objects', () => {
  for (const v of [null, [], 3, 'x', true]) assert.equal(isJsonObject(v), false);
  assert.equal(isJsonObject({}), true);
});

test('S2: approval decision with a null body is a 400, not a TypeError', async () => {
  const { out, json } = recorder();
  const decide = () => { throw new Error('must not be reached'); };
  const route = createApprovalRoutes({ json, readBody: async () => 'null', pendingApprovals: new Map([['ap', { userId: 'u1', decide }]]), requestScope: { getStore: () => ({ workspace: { userId: 'u1' } }) } });
  assert.equal(await route({ method: 'POST' }, {}, { path: '/api/tool-approvals/ap' }), true);
  assert.equal(out.status, 400);
});

test('S2: chat with a null or array body is a 400 and never reaches the loop', async () => {
  for (const raw of ['null', '[]', '7']) {
    const { out, json } = recorder();
    const route = createChatRoutes({ json, readBody: async () => raw, bodyCap: 1e6, rateLimited: () => false, diaryEnabled: () => true, handleChat: async () => { throw new Error('reached'); } });
    assert.equal(await route({ method: 'POST' }, {}, { path: '/api/chat', authn: { user: { id: 'u1' } } }), true);
    assert.equal(out.status, 400, raw);
  }
});

test('S3/S4: history route sanitizes ids like storage, honours tombstones, rejects empty ids', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-hardening-'));
  try {
    lists.addTombstone(dir, 'chat-a1');
    const captured = [];
    const writes = [];
    const route = createChatListRoutes({
      json: (_r, status, body) => { captured.push({ status, body }); return true; },
      readBody: async (req) => req.body, currentWorkspace: () => ({ dir }), PROJECTS: [], FREE_CHATS: [], diaryExtras: {}, crypto,
      STORED_HISTORY_BYTES: 1e6, STORED_HISTORY_CAP: 100, chatLists: () => ({ freeChats: [], projects: [] }), removeChat: () => true,
      store: { sanitizeChats: (c) => c, saveFreeChats() {}, deleteFreeChat() {}, readHistory: () => [], writeHistory: (id) => writes.push(id) },
    });
    const send = (rawId, body = '{"history":[]}') => route({ method: 'POST', body }, {}, { path: `/api/chats/${encodeURIComponent(rawId)}/history` }).then(() => captured.at(-1));
    assert.equal((await send('chat-a1..')).status, 410);
    assert.equal((await send('chat-a1!')).status, 410, 'a raw id that sanitizes to a deleted chat cannot resurrect it');
    assert.equal((await send('chat-a1..')).status, 410);
    assert.equal((await send('!!!')).status, 400, 'an id that sanitizes to nothing is rejected');
    assert.equal((await send('chat-b2', 'null')).status, 400);
    assert.equal((await send('chat-b2')).status, 200);
    assert.deepEqual(writes, ['chat-b2']);
    await route({ method: 'GET' }, {}, { path: '/api/chats/%21%21/history' });
    assert.equal(captured.at(-1).status, 400);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('S3: deleting a raw id with stripped characters blocks its history under both spellings', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-hardening-'));
  try {
    lists.addTombstone(dir, 'chat.1');
    assert.ok(lists.readTombstones(dir).has('chat.1') && lists.readTombstones(dir).has('chat1'));
    lists.addTombstone(dir, 'chat.1');
    assert.equal([...lists.readTombstones(dir)].length, 2, 'deduped');
    const captured = [];
    const route = createChatListRoutes({
      json: (_r, status, body) => { captured.push({ status, body }); return true; },
      readBody: async (req) => req.body, currentWorkspace: () => ({ dir }), PROJECTS: [], FREE_CHATS: [], diaryExtras: {}, crypto,
      STORED_HISTORY_BYTES: 1e6, STORED_HISTORY_CAP: 100, chatLists: () => ({ freeChats: [], projects: [] }), removeChat: () => true,
      store: { sanitizeChats: (c) => c, saveFreeChats() {}, deleteFreeChat() {}, readHistory: () => [], writeHistory: () => { throw new Error('wrote'); } },
    });
    for (const id of ['chat.1', 'chat1']) {
      await route({ method: 'POST', body: '{"history":[]}' }, {}, { path: `/api/chats/${id}/history` });
      assert.equal(captured.at(-1).status, 410, id);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('S3: safeChatId matches the storage rule', () => {
  assert.equal(lists.safeChatId('a/b..c!_-9'), 'abc_-9');
  assert.equal(lists.safeChatId(null), '');
});

test('S4: the store refuses a history path for an id that sanitizes to nothing', () => {
  const { createProjectStore } = require('../../server/projects.cjs');
  const store = createProjectStore({ fs, path, PROJECTS: [], FREE_CHATS: [], currentWorkspace: () => ({ dir: os.tmpdir(), historyPath: (id) => path.join(os.tmpdir(), `never-${id}.json`) }) });
  assert.throws(() => store.historyPath('../..'), (e) => e.status === 400);
  assert.equal(store.historyPath('c/1'), path.join(os.tmpdir(), 'never-c1.json'));
});

test('S-P1: approve_all without a chat id approves only that call and grants nothing shared', async () => {
  const gate = createApprovals();
  const ctrl = new AbortController();
  const p = gate.awaitApproval({ id: 'a', userId: 'u1', chatId: null, abortSignal: ctrl.signal });
  assert.equal(gate.pendingApprovals.get('a').decide('approve_all'), true);
  assert.equal(await p, 'approve');
  assert.equal(gate.chatWideApproved('u1', null), false, 'another id-less chat is still asked');
  assert.equal(gate.chatWideApproved('u1', ''), false);
  const q = gate.awaitApproval({ id: 'b', userId: 'u1', chatId: 'c1', abortSignal: ctrl.signal });
  gate.pendingApprovals.get('b').decide('approve_all');
  assert.equal(await q, 'approve');
  assert.equal(gate.chatWideApproved('u1', 'c1'), true, 'a real chat still gets its grant');
  assert.equal(gate.chatWideApproved('u1', 'c2'), false);
  assert.equal(gate.chatWideApproved('u2', 'c1'), false);
});

test('S-P2: an already-aborted request resolves at once and parks nothing', async () => {
  const gate = createApprovals({ timeoutMs: 60_000 });
  const ctrl = new AbortController();
  ctrl.abort();
  const started = Date.now();
  assert.equal(await gate.awaitApproval({ id: 'z', userId: 'u1', chatId: 'c1', abortSignal: ctrl.signal }), 'aborted');
  assert.ok(Date.now() - started < 1000);
  assert.equal(gate.pendingApprovals.has('z'), false);
});
