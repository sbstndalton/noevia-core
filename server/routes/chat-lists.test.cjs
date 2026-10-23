'use strict';
const { binding: permissionBinding } = require('../../tests/server/chat-grant-fixture.cjs');
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
    readHistory: (id) => histories.get(id) || [],
  };
  // sbstndalton/noevia#1071 slice 4: the transcript is written through the Rust store (its in-process
  // stand-in here, tests/server/project-store-server.cjs), never by this route.
  const storeCalls = [];
  let transcripts = require('../../tests/server/project-store-server.cjs').localTranscripts(dir, storeCalls);
  const routes = createChatListRoutes({
    json: (res, status, body) => { sent.push({ status, body }); },
    readBody: async (req, limit) => { let s = ''; for await (const c of req) s += c; if (limit && s.length > limit) throw Object.assign(new Error('too big'), { status: 413 }); return s; },
    currentWorkspace: () => ({ dir, transcripts }),
    PROJECTS: projects, FREE_CHATS: freeChats,
    diaryExtras: { internalProject: (p) => p.id === 'diary-extras' },
    STORED_HISTORY_BYTES: 200,
    chatLists: () => ({ freeChats: Array.from(freeChats), projects }),
    removeChat: (chat) => removed.push(chat),
    store,
  });
  const headers = {};
  const call = (method, path, body, role = 'member') => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
    req.method = method;
    return routes(req, { setHeader: (k, v) => { headers[k] = v; } }, { path, authn: { user: { id: 'u1', role } } });
  };
  const stored = (id) => { try { return JSON.parse(fs.readFileSync(path.join(dir, `history-${id}.json`), 'utf8')).history; } catch { return undefined; } };
  return { call, routes, sent, removed, projects, freeChats, histories, store, dir, storeCalls, stored, headers, setTranscripts: (t) => { transcripts = t; } };
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
test('the free-chat list and a free chat\'s delete are not this mount\'s any more (#1071 slice 6)', async () => {
  const f = fixture();
  for (const m of ['GET', 'POST', 'PUT']) assert.equal(await f.call(m, '/api/freechats', m === 'POST' ? { chats: [{ id: 'f2' }] } : undefined), false, m);
  assert.equal(await f.call('DELETE', '/api/freechats/f1'), false, 'the Rust front answers the delete');
  assert.equal(f.sent.length, 0);
  assert.equal(f.store.savedFree, undefined, 'nothing saved');
  assert.deepEqual(f.freeChats.map((c) => c.id), ['f1'], 'nothing deleted');
});

test('#1071 slice 5: a chat\'s transcript is no longer answered here, read or save (the Rust front owns both)', async () => {
  const f = fixture();
  for (const method of ['GET', 'POST', 'PUT']) {
    assert.equal(await f.call(method, '/api/chats/c1/history', method === 'GET' ? undefined : { history: [1] }), false, method);
  }
  assert.equal(f.sent.length, 0);
  assert.deepEqual(f.storeCalls, [], 'no store write from Node');
  assert.equal(f.stored('c1'), undefined, 'nothing saved');
});

test('#1071: a chat\'s context meter is no longer answered here (the Rust front owns it)', async () => {
  const f = fixture();
  require('../chat-context.cjs').save(f.dir, 'c1', { meter: { model: 'synthetic', used: 5 } });
  assert.equal(await f.call('GET', '/api/chats/c1/context-window'), false);
  assert.equal(f.sent.length, 0);
});

test('Node list mount has no move handler even if an injected store offers one',async()=>{
 const f=fixture();f.store.moveChat=()=>{throw Error('duplicate handler invoked');};
 const route=createChatListRoutes({json:()=>{throw Error('duplicate reply');},readBody:async()=>{throw Error('body read behind front');},currentWorkspace:()=>({}),store:f.store});
 assert.equal(await route({method:'POST'},{},{path:'/api/chats/qa/move'}),false);
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

test('#1507: a saved transcript supersedes a saved partial reply (which the Rust front\'s GET offers, #1071)', async () => {
  const f = fixture();
  const partial = require('../chat-partial.cjs');
  fs.mkdirSync(path.join(f.dir, 'chat-partials'), { recursive: true });
  fs.writeFileSync(partial.fileFor(f.dir, 'c1'), JSON.stringify({ role: 'assistant', content: 'half a rep', interrupted: true }));
  assert.equal(await f.call('GET', '/api/chats/c1/history'), false, 'the GET is not this mount\'s');
  assert.equal(await f.call('POST', '/api/chats/c1/history', { history: [{ role: 'user', content: 'next' }] }), false, 'nor the save (#1071 slice 5)');
  assert.equal(fs.existsSync(partial.fileFor(f.dir, 'c1')), true, 'Node supersedes nothing itself');
  // The Rust front's save (here its in-process stand-in) supersedes it.
  await require('../../tests/server/project-store-server.cjs').localTranscripts(f.dir).write('c1', [{ role: 'user', content: 'next' }], { supersedePartial: true, origin: 'history' });
  assert.equal(fs.existsSync(partial.fileFor(f.dir, 'c1')), false, 'the saved transcript supersedes the partial');
});
