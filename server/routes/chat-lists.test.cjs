'use strict';
// The chat-list routes over a fake store: the workspace view with its sanitized chats and the
// hourly sweep, the free-chat merge, and the transcript's revision check. The merge and
// tombstones are chat-lists.test.cjs; the sweep's rules are chat-retention.test.cjs; the
// same routes end to end are chat-lists-routes.test.cjs and chat-history-routes.test.cjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { createChatListRoutes } = require('./chat-lists.cjs');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-chat-lists-'));
  const sent = [], removed = [];
  const projects = [{ id: 'p1', name: 'One', chats: [{ id: 'c1' }, 'orphan'] }, { id: 'diary-extras', name: 'Diary', chats: [] }];
  const freeChats = [{ id: 'f1', title: 'Free' }];
  const histories = new Map();
  const store = {
    sanitizeChats: (chats) => (chats || []).filter((c) => c && typeof c === 'object' && typeof c.id === 'string'),
    saveFreeChats: (list) => { store.savedFree = Array.from(list); },
    deleteFreeChat: (id) => { const i = freeChats.findIndex((c) => c.id === id); if (i < 0) return false; freeChats.splice(i, 1); removed.push(id); return true; },
    readHistory: (id) => histories.get(id) || [],
    writeHistory: (id, history) => histories.set(id, history),
  };
  const routes = createChatListRoutes({
    json: (res, status, body) => { sent.push({ status, body }); },
    readBody: async (req, limit) => { let s = ''; for await (const c of req) s += c; if (limit && s.length > limit) throw Object.assign(new Error('too big'), { status: 413 }); return s; },
    currentWorkspace: () => ({ dir }),
    PROJECTS: projects, FREE_CHATS: freeChats,
    diaryExtras: { internalProject: (p) => p.id === 'diary-extras' },
    crypto, STORED_HISTORY_BYTES: 200, STORED_HISTORY_CAP: 3,
    chatLists: () => ({ freeChats: Array.from(freeChats), projects }),
    removeChat: (chat) => removed.push(chat),
    store,
  });
  const call = (method, path, body, role = 'member') => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
    req.method = method;
    return routes(req, {}, { path, authn: { user: { id: 'u1', role } } });
  };
  return { call, sent, removed, projects, freeChats, histories, store, dir };
}

test('the workspace view hides the internal project and sanitizes chat metas', async () => {
  const f = fixture();
  assert.equal(await f.call('GET', '/api/workspace/x'), false);
  assert.equal(await f.call('GET', '/api/workspace'), true);
  const { status, body } = f.sent.pop();
  assert.equal(status, 200);
  assert.deepEqual(body.projects.map((p) => p.id), ['p1']);
  assert.deepEqual(body.projects[0].chats, [{ id: 'c1' }]);
  assert.deepEqual(body.freeChats, [{ id: 'f1', title: 'Free' }]);
  assert.equal(f.projects[0].chats.length, 2, 'the stored list is left alone');
});

test('free chats are normalized, merged and deleted with the original answers', async () => {
  const f = fixture();
  await f.call('GET', '/api/freechats');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { chats: [{ id: 'f1', title: 'Free' }] } });
  await f.call('POST', '/api/freechats', { chats: 'nope' });
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'chats array required' } });
  await f.call('POST', '/api/freechats', '{');
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'invalid JSON' } });
  await f.call('POST', '/api/freechats', { chats: [{ id: 'f 2!', preview: 'p'.repeat(300) }, { title: 'no id' }] });
  assert.deepEqual(f.sent.pop(), { status: 200, body: { ok: true } });
  const added = f.freeChats.find((c) => c.id === 'f2');
  assert.equal(added.title, 'New chat');
  assert.equal(added.preview.length, 200);
  assert.equal(added.pinned, false);
  assert.deepEqual(f.store.savedFree.map((c) => c.id).sort(), ['f1', 'f2']);
  assert.equal(await f.call('PUT', '/api/freechats'), false, 'an unhandled method falls through');
  await f.call('DELETE', '/api/freechats/f1');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { ok: true } });
  await f.call('DELETE', '/api/freechats/f1');
  assert.deepEqual(f.sent.pop(), { status: 404, body: { error: 'no such chat' } });
});

test('transcripts carry a revision; a stale save gets the current copy back; a deleted chat is gone', async () => {
  const f = fixture();
  await f.call('GET', '/api/chats/c1/history');
  const empty = f.sent.pop();
  assert.deepEqual(empty.body.history, []);
  const emptyRevision = empty.body.revision;
  await f.call('POST', '/api/chats/c1/history', { history: [1, 2, 3, 4, 5], baseRevision: emptyRevision });
  const saved = f.sent.pop();
  assert.equal(saved.status, 200);
  assert.deepEqual(f.histories.get('c1'), [3, 4, 5], 'the stored transcript is capped from the end');
  await f.call('POST', '/api/chats/c1/history', { history: [9], baseRevision: emptyRevision });
  const stale = f.sent.pop();
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, 'This chat changed on another device.');
  assert.deepEqual(stale.body.history, [3, 4, 5]);
  assert.equal(stale.body.revision, saved.body.revision);
  await f.call('POST', '/api/chats/c1/history', { history: [9] });
  assert.equal(f.sent.pop().status, 200, 'a save without a base revision is accepted as before');
  await f.call('POST', '/api/chats/c1/history', { history: ['x'.repeat(300)] });
  assert.deepEqual(f.sent.pop(), { status: 413, body: { error: 'This chat is too large to save; start a new chat to keep going.' } });
  require('../chat-lists.cjs').addTombstone(f.dir, 'c1');
  await f.call('POST', '/api/chats/c1/history', { history: [] });
  assert.deepEqual(f.sent.pop(), { status: 410, body: { error: 'This chat was deleted.' } });
  assert.equal(await f.call('PUT', '/api/chats/c1/history'), false);
});

test('the context meter reads null when nothing was recorded', async () => {
  const f = fixture();
  await f.call('GET', '/api/chats/c1/context-window');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { meter: null } });
});

test('a deleted chat reads the same as one that never existed, even with state written back late (#554)', async () => {
  const f = fixture();
  require('../chat-context.cjs').save(f.dir, 'c-gone', { meter: { model: 'synthetic', used: 5 } });
  await f.call('GET', '/api/chats/c-gone/context-window');
  assert.equal(f.sent.pop().body.meter.used, 5);
  require('../chat-lists.cjs').addTombstone(f.dir, 'c-gone');
  await f.call('GET', '/api/chats/c-gone/context-window');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { meter: null } });
});

test('a member cannot save a Cowork mode on a free chat; it is coerced to Chat (#236)', async () => {
  const f = fixture();
  await f.call('POST', '/api/freechats', { chats: [{ id: 'fc', mode: 'cowork' }] });
  assert.equal(f.sent.pop().status, 200);
  assert.equal('mode' in f.freeChats.find((c) => c.id === 'fc'), false);
});

test('an admin free chat keeps its Cowork mode; anything else reads back as Chat (#236)', async () => {
  const f = fixture();
  await f.call('POST', '/api/freechats', { chats: [{ id: 'fc', mode: 'cowork' }, { id: 'fx', mode: 'shell' }, { id: 'fy' }] }, 'admin');
  assert.equal(f.freeChats.find((c) => c.id === 'fc').mode, 'cowork');
  assert.equal('mode' in f.freeChats.find((c) => c.id === 'fx'), false);
  assert.equal('mode' in f.freeChats.find((c) => c.id === 'fy'), false);
});

test('POST /api/chats/:id/move validates, scopes to the caller and maps the store outcome (#738)', async () => {
  const f = fixture();
  const moves = [];
  f.store.moveChat = (id, projectId, patch, allowed) => {
    moves.push({ id, projectId, patch, internalAllowed: allowed({ id: 'diary-extras' }), p1Allowed: allowed({ id: 'p1' }) });
    return id === 'f1' ? { status: 200, from: null } : { status: 404 };
  };
  // The routes destructure the store once, so build them again with the move in place.
  const routes = createChatListRoutes({
    json: (res, status, body) => { f.sent.push({ status, body }); },
    readBody: async (req) => { let s = ''; for await (const c of req) s += c; return s; },
    currentWorkspace: () => ({ dir: f.dir }), PROJECTS: f.projects, FREE_CHATS: f.freeChats,
    diaryExtras: { internalProject: (p) => p.id === 'diary-extras' }, crypto, STORED_HISTORY_BYTES: 200, STORED_HISTORY_CAP: 3,
    chatLists: () => ({ freeChats: [], projects: [] }), removeChat() {}, store: f.store,
  });
  const call = (method, p, body) => { const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]); req.method = method; return routes(req, {}, { path: p, authn: { user: { id: 'u1', role: 'member' } } }); };
  const frame = { kind: 'idea', tags: [], links: [], confirmed: true, source: 'user' };
  assert.equal(await call('POST', '/api/chats/f1/move', { projectId: 'p1', frame }), true);
  assert.deepEqual(f.sent.pop(), { status: 200, body: { ok: true, from: null, projectId: 'p1' } });
  assert.deepEqual(moves.pop(), { id: 'f1', projectId: 'p1', patch: { frame }, internalAllowed: false, p1Allowed: true });
  await call('POST', '/api/chats/f1/move', { projectId: null });
  f.sent.pop();
  assert.deepEqual(moves.pop().patch, {}, 'no frame in the body leaves the frame alone');
  await call('POST', '/api/chats/zz/move', { projectId: null });
  assert.deepEqual(f.sent.pop(), { status: 404, body: { error: 'no such chat or project' } });
  moves.length = 0;
  for (const bad of [{}, { projectId: 3 }, [], 'not json']) {
    await call('POST', '/api/chats/f1/move', bad);
    assert.equal(f.sent.pop().status, 400);
  }
  await call('POST', '/api/chats/f1/move', { projectId: 'p1', frame: { kind: 'bogus' } });
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'invalid frame' } }, 'an invalid frame is refused (#759)');
  assert.equal(moves.length, 0, 'malformed bodies never reach the store');
  assert.equal(await call('GET', '/api/chats/f1/move'), false, 'other methods fall through');
});

// Grants "Allow for this chat" the way the card does: a pending write answered with approve_all.
async function grantAllowForChat(gate, userId, chatId) {
  const ctl = new AbortController();
  const waiting = gate.awaitApproval({ id: `grant-${userId}-${chatId}`, userId, chatId, abortSignal: ctl.signal });
  assert.equal(gate.pendingApprovals.get(`grant-${userId}-${chatId}`).decide('approve_all'), true);
  assert.equal(await waiting, 'approve');
}

test('moving a chat to another list revokes its "Allow for this chat" grant; a frame saved in place keeps it (#814)', async () => {
  const gate = require('../approvals.cjs').createApprovals();
  const f = fixture();
  const lists = { f1: null, f2: null };
  f.store.moveChat = (id, projectId) => {
    if (!(id in lists)) return { status: 404 };
    const from = lists[id]; lists[id] = projectId; return { status: 200, from };
  };
  const sent = [];
  const routes = createChatListRoutes({
    json: (res, status, body) => { sent.push({ status, body }); },
    readBody: async (req) => { let s = ''; for await (const c of req) s += c; return s; },
    currentWorkspace: () => ({ dir: f.dir, userId: 'u1' }), PROJECTS: f.projects, FREE_CHATS: f.freeChats,
    diaryExtras: { internalProject: (p) => p.id === 'diary-extras' }, crypto, STORED_HISTORY_BYTES: 200, STORED_HISTORY_CAP: 3,
    chatLists: () => ({ freeChats: [], projects: [] }), removeChat() {}, store: f.store, revokeChatGrant: gate.revokeChatGrant,
  });
  const move = (id, body) => { const req = Readable.from([Buffer.from(JSON.stringify(body))]); req.method = 'POST'; return routes(req, {}, { path: `/api/chats/${id}/move`, authn: { user: { id: 'u1', role: 'member' } } }); };
  await grantAllowForChat(gate, 'u1', 'f1');
  await grantAllowForChat(gate, 'u1', 'f2');
  await grantAllowForChat(gate, 'u2', 'f1');
  // In place (no list change): the next write in that chat is still not asked.
  await move('f1', { projectId: null, frame: { kind: 'idea', tags: [], links: [], confirmed: true, source: 'user' } });
  assert.equal(sent.pop().status, 200);
  assert.equal(gate.chatWideApproved('u1', 'f1'), true, 'no move: still suppressed');
  // Into a project: the next write asks again. Other chats and other users keep theirs.
  await move('f1', { projectId: 'p1' });
  assert.deepEqual(sent.pop(), { status: 200, body: { ok: true, from: null, projectId: 'p1' } });
  assert.equal(gate.chatWideApproved('u1', 'f1'), false, 'moved: the next write asks again');
  assert.equal(gate.chatWideApproved('u1', 'f2'), true, 'another chat keeps its grant');
  assert.equal(gate.chatWideApproved('u2', 'f1'), true, 'another user keeps theirs');
  // A refused move changes nothing.
  await grantAllowForChat(gate, 'u1', 'f1');
  await move('zz', { projectId: null });
  assert.equal(sent.pop().status, 404);
  assert.equal(gate.chatWideApproved('u1', 'f1'), true);
});
