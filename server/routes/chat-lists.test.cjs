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
  const call = (method, path, body) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
    req.method = method;
    return routes(req, {}, { path, authn: { user: { id: 'u1' } } });
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
