'use strict';
const { binding: permissionBinding } = require('../../tests/server/chat-grant-fixture.cjs');
// The chat-list routes over a fake store: the workspace view with its sanitized chats and the
// hourly sweep, a free chat's delete, and the transcript's revision check. The merge and
// tombstones are chat-lists.test.cjs; the sweep's rules are native Rust (noevia-rs retention.rs); the
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

// GET /api/workspace is the Rust front's (#2191 close-out; noevia-rs tests/workspace.rs holds the view, the
// retention sweep and the orphan cleanup): this mount no longer has it, and index.cjs refuses it first.
test('the workspace list is not this mount\'s any more (#2191)', async () => {
  const f = fixture();
  for (const p of ['/api/workspace', '/api/workspace/x']) assert.equal(await f.call('GET', p), false, p);
  assert.equal(f.sent.length, 0);
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
// GET /api/chats/search (#1450) and GET /api/chats/:id/export (#1471) are the Rust front's (noevia-rs
// bins/noevia-server tests/chat_lists_read.rs and the Node-differential crates/server-projects tests/chat_lists_oracle.rs
// hold their behaviour): this mount no longer answers either, and index.cjs refuses both GETs first
// (rust-chat-search-export.test.cjs).
test('the chat search and the single-chat download are not this mount\'s any more', async () => {
  const f = fixture();
  f.histories.set('f1', [{ role: 'user', content: 'thirty' }]);
  f.store.readHistory = () => { throw new Error('transcript read behind the front'); };
  for (const [m, p] of [['GET', '/api/chats/search'], ['GET', '/api/chats/f1/export'], ['POST', '/api/chats/f1/export'], ['GET', '/api/chats/bad%20id!/export']]) {
    const url = new URL(`http://localhost${p}?q=thirty`);
    const req = Readable.from([]); req.method = m;
    assert.equal(await f.routes(req, {}, { path: p, authn: { user: { id: 'u1', role: 'member' } }, url }), false, `${m} ${p}`);
  }
  assert.equal(f.sent.length, 0);
  const source = fs.readFileSync(path.join(__dirname, 'chat-lists.cjs'), 'utf8');
  assert.equal(source.includes("p === '/api/chats/search'"), false);
  assert.equal(source.includes('chatMarkdown('), false);
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
