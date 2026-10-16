'use strict';
// The chat-list routes over a fake store: the workspace view with its sanitized chats and the
// hourly sweep, a free chat's delete, and the transcript's revision check. The merge and
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
  return { call, routes, sent, removed, projects, freeChats, histories, store, dir };
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

// GET and POST /api/freechats are the Rust front's (#1071): this mount no longer has them, and
// index.cjs refuses them first (rust-projects.test.cjs). A free chat's delete stays here.
test('the free-chat list is not this mount\'s any more; a free chat is deleted with the original answers', async () => {
  const f = fixture();
  for (const m of ['GET', 'POST', 'PUT']) assert.equal(await f.call(m, '/api/freechats', m === 'POST' ? { chats: [{ id: 'f2' }] } : undefined), false, m);
  assert.equal(f.sent.length, 0);
  assert.equal(f.store.savedFree, undefined, 'nothing saved');
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
  const waiting = gate.awaitApproval({ id: `grant-${userId}-${chatId}`, userId, chatId, scope: 'space:free', abortSignal: ctl.signal });
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
  assert.equal(gate.chatWideApproved('u1', 'f1', 'space:free'), true, 'no move: still suppressed');
  // Into a project: the next write asks again. Other chats and other users keep theirs.
  await move('f1', { projectId: 'p1' });
  assert.deepEqual(sent.pop(), { status: 200, body: { ok: true, from: null, projectId: 'p1' } });
  assert.equal(gate.chatWideApproved('u1', 'f1', 'space:free'), false, 'moved: the next write asks again');
  assert.equal(gate.chatWideApproved('u1', 'f2', 'space:free'), true, 'another chat keeps its grant');
  assert.equal(gate.chatWideApproved('u2', 'f1', 'space:free'), true, 'another user keeps theirs');
  // A refused move changes nothing.
  await grantAllowForChat(gate, 'u1', 'f1');
  await move('zz', { projectId: null });
  assert.equal(sent.pop().status, 404);
  assert.equal(gate.chatWideApproved('u1', 'f1', 'space:free'), true);
});

test('#1471 a chat exports as one Markdown file from its own lists; unknown, deleted and other-list ids answer 404', async () => {
  const f = fixture();
  f.histories.set('f1', [{ role: 'user', content: 'What is 12 times 3?' }, { role: 'assistant', content: 'Thirty-six.' }]);
  f.projects[0].chats = [{ id: 'c1', title: 'Project chat' }];
  f.histories.set('c1', [{ role: 'user', content: 'Project question' }]);
  const reply = async (method, path) => {
    const res = { headers: null, body: null, writeHead(status, headers) { this.status = status; this.headers = headers; }, end(value) { this.body = Buffer.from(value); } };
    const req = Readable.from([]);
    req.method = method;
    const handled = await f.routes(req, res, { path, authn: { user: { id: 'u1', role: 'member' } } });
    return { handled, res };
  };
  const routes = f.routes;
  assert.equal(typeof routes, 'function', 'fixture exposes the routes');
  const free = await reply('GET', '/api/chats/f1/export');
  assert.equal(free.handled, true);
  assert.equal(free.res.status, 200);
  assert.equal(free.res.headers['Content-Type'], 'text/markdown; charset=utf-8');
  assert.match(free.res.headers['Content-Disposition'], /^attachment; filename="noevia-chat-free-f1\.md"$/);
  const text = free.res.body.toString('utf8');
  assert.match(text, /^# Free\n/);
  assert.match(text, /## You\n\nWhat is 12 times 3\?/);
  assert.match(text, /## Assistant\n\nThirty-six\./);
  const project = await reply('GET', '/api/chats/c1/export');
  assert.equal(project.res.status, 200);
  assert.match(project.res.body.toString('utf8'), /Project question/);
  const unknown = await reply('GET', '/api/chats/c-nope/export');
  assert.equal(unknown.handled, true);
  assert.deepEqual(f.sent.pop(), { status: 404, body: { error: 'This chat was not found.' } });
  f.histories.set('diary-x', []);
  f.projects.push({ id: 'diary-extras', name: 'Diary', chats: [{ id: 'dx', title: 'Diary' }] });
  await reply('GET', '/api/chats/dx/export');
  assert.equal(f.sent.pop().status, 404, 'a chat in the internal project is not a chat of this list');
  const bad = await reply('GET', '/api/chats/bad%20id!/export');
  assert.equal(bad.handled, true);
  assert.equal(await reply('POST', '/api/chats/f1/export').then(r => r.handled), false, 'only GET reads the export');
});

// #1450: the transcript search finds the chats whose message text holds the query, within this person's own lists.
test('#1450 search matches message text in this person chats, not the internal list, and answers a short query with nothing', async () => {
  const f = fixture();
  f.histories.set('f1', [{ role: 'user', content: 'What is 12 times 3?' }, { role: 'assistant', content: 'Thirty-six.' }]);
  f.projects[0].chats = [{ id: 'c1', title: 'Project chat' }];
  f.histories.set('c1', [{ role: 'user', content: 'PINEAPPLE recipe' }]);
  f.projects.push({ id: 'diary-extras', name: 'Diary', chats: [{ id: 'dx', title: 'Diary' }] });
  f.histories.set('dx', [{ role: 'user', content: 'PINEAPPLE in the diary' }]);
  const search = async (q) => {
    const req = Readable.from([]);
    req.method = 'GET';
    const url = new URL(`http://localhost/api/chats/search?q=${encodeURIComponent(q)}`);
    const handled = await f.routes(req, {}, { path: '/api/chats/search', authn: { user: { id: 'u1', role: 'member' } }, url });
    assert.equal(handled, true);
    return f.sent.pop();
  };
  assert.deepEqual(await search('thirty'), { status: 200, body: { chats: ['f1'], truncated: false } });
  assert.deepEqual(await search('pineapple'), { status: 200, body: { chats: ['c1'], truncated: false } }, 'the internal diary project is not searched');
  assert.deepEqual(await search('x'), { status: 200, body: { chats: [], truncated: false } }, 'a one-letter query reads nothing');
  assert.deepEqual(await search('nothing-matches-this'), { status: 200, body: { chats: [], truncated: false } });
  assert.equal((await search('a'.repeat(201))).status, 400);
});

test('#1450 search reads only the chats that are still in the lists', async () => {
  const f = fixture();
  f.histories.set('f1', [{ role: 'user', content: 'findme' }]);
  f.histories.set('c1', [{ role: 'user', content: 'findme' }]);
  f.projects[0].chats = [{ id: 'c1', title: 'x' }];
  const search = async (q) => {
    const req = Readable.from([]); req.method = 'GET';
    await f.routes(req, {}, { path: '/api/chats/search', authn: { user: { id: 'u1', role: 'member' } }, url: new URL(`http://localhost/api/chats/search?q=${encodeURIComponent(q)}`) });
    return f.sent.pop();
  };
  assert.deepEqual((await search('findme')).body.chats.sort(), ['c1', 'f1']);
  f.freeChats.length = 0;
  f.projects[0].chats = [];
  assert.deepEqual((await search('findme')).body.chats, [], 'a chat no longer in the lists is not reported');
});

test('#1507: a saved partial reply comes with the transcript, and a saved transcript supersedes it', async () => {
  const f = fixture();
  const partial = require('../chat-partial.cjs');
  fs.mkdirSync(path.join(f.dir, 'chat-partials'), { recursive: true });
  fs.writeFileSync(partial.fileFor(f.dir, 'c1'), JSON.stringify({ role: 'assistant', content: 'half a rep', interrupted: true }));
  await f.call('GET', '/api/chats/c1/history');
  const got = f.sent.pop();
  assert.equal(got.status, 200);
  assert.deepEqual(got.body.partial, { role: 'assistant', content: 'half a rep', interrupted: true });
  assert.deepEqual(got.body.history, [], 'the transcript itself is unchanged by the partial');
  await f.call('POST', '/api/chats/c1/history', { history: [{ role: 'user', content: 'next' }] });
  assert.equal(f.sent.pop().status, 200);
  assert.equal(fs.existsSync(partial.fileFor(f.dir, 'c1')), false, 'the saved transcript supersedes the partial');
  await f.call('GET', '/api/chats/c1/history');
  assert.equal(f.sent.pop().body.partial, undefined);
});
