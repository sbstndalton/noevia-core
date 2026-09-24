const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { createAccountRoutes } = require('./account.cjs');

test('retention PUT refuses to delete more chats than were confirmed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-routes-'));
  const NOW = Date.UTC(2026, 8, 17);
  let free = [{ id: 'old', updatedAt: NOW - 200 * 86400000 }, { id: 'new', updatedAt: NOW }];
  const removed = [];
  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const readJson = async (req) => { let raw = ''; for await (const c of req) raw += c; return JSON.parse(raw); };
  const routes = createAccountRoutes({ json, readJson, dir: () => dir, now: () => NOW, chatLists: () => ({ freeChats: free, projects: [] }), removeChat: (c) => { removed.push(c.id); free = free.filter((x) => x.id !== c.id); } });
  const server = http.createServer((req, res) => void routes(req, res, { path: req.url, authn: { user: { id: 'u' } } }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/api/account/retention`;
  const put = (body) => fetch(url, { method: 'PUT', body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  try {
    assert.equal((await fetch(url).then((r) => r.json())).preview['90'], 1);
    let r = await put({ days: 90 });
    assert.equal(r.status, 409); assert.deepEqual(removed, []);
    assert.equal(fs.existsSync(path.join(dir, 'chat-retention.json')), false, 'nothing saved');
    r = await put({ days: 90, confirmDeletes: 1 });
    assert.equal(r.status, 200); assert.equal(r.body.deleted, 1); assert.deepEqual(removed, ['old']);
    assert.equal((await put({ days: 0 })).status, 200);
  } finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('memory GET/PUT: own account, validated, 401 without sign-in', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-mem-routes-'));
  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const readJson = async (req) => { let raw = ''; for await (const c of req) raw += c; return JSON.parse(raw); };
  const routes = createAccountRoutes({ json, readJson, dir: () => dir, now: () => 5 });
  const server = http.createServer((req, res) => void routes(req, res, { path: new URL(req.url, 'http://x').pathname, authn: req.headers['x-anon'] ? null : { user: { id: 'u' } } }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/api/account/memory`;
  try {
    assert.equal((await fetch(url, { headers: { 'x-anon': '1' } })).status, 401);
    assert.deepEqual(await fetch(url).then((r) => r.json()), { memories: [], useProjectMemories: true, updatedAt: null, maxItems: 50, maxItemChars: 300 });
    let r = await fetch(url, { method: 'PUT', body: JSON.stringify({ memories: ['I live in Oslo'], useProjectMemories: false }) });
    assert.equal(r.status, 200);
    assert.deepEqual((await r.json()).memories, ['I live in Oslo']);
    r = await fetch(url, { method: 'PUT', body: JSON.stringify({ memories: 'nope' }) });
    assert.equal(r.status, 400);
    assert.equal((await fetch(url).then((x) => x.json())).useProjectMemories, false);
  } finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('preferences GET/PUT are per account: one user never reads or writes another', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-prefs-routes-'));
  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const readJson = async (req) => { let raw = ''; for await (const c of req) raw += c; return JSON.parse(raw); };
  let current = 'alice';
  const routes = createAccountRoutes({ json, readJson, dir: () => path.join(root, current), now: () => 9 });
  const server = http.createServer((req, res) => { current = req.headers['x-user'] || 'alice'; void routes(req, res, { path: new URL(req.url, 'http://x').pathname, authn: req.headers['x-anon'] ? null : { user: { id: current } } }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/api/account/preferences`;
  const as = (user, init = {}) => fetch(url, { ...init, headers: { 'x-user': user, ...(init.headers || {}) } });
  try {
    assert.equal((await fetch(url, { headers: { 'x-anon': '1' } })).status, 401);
    let r = await as('alice', { method: 'PUT', body: JSON.stringify({ sendKey: 'mod-enter', notifications: { approvalNeeded: false } }) });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.sendKey, 'mod-enter'); assert.deepEqual(body.options.notificationEvents, ['replyFinished', 'approvalNeeded']);
    const bob = await as('bob').then((x) => x.json());
    assert.equal(bob.sendKey, 'enter'); assert.equal(bob.notifications.approvalNeeded, true);
    assert.equal((await as('bob', { method: 'PUT', body: JSON.stringify({ locale: 'zz' }) })).status, 400);
    assert.equal((await as('bob', { method: 'DELETE' })).status, 405);
    assert.equal((await as('alice').then((x) => x.json())).notifications.approvalNeeded, false);
  } finally { server.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('instructions PUT carries the advanced style and language through the route', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-instr-routes-'));
  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const readJson = async (req) => { let raw = ''; for await (const c of req) raw += c; return JSON.parse(raw); };
  const routes = createAccountRoutes({ json, readJson, dir: () => dir });
  const server = http.createServer((req, res) => void routes(req, res, { path: req.url, authn: { user: { id: 'u' } } }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/api/account/instructions`;
  try {
    const r = await fetch(url, { method: 'PUT', body: JSON.stringify({ text: '', style: 'default', advanced: { formatting: 'minimal' }, language: 'German' }) });
    const body = await r.json();
    assert.equal(r.status, 200); assert.equal(body.advanced.formatting, 'minimal'); assert.equal(body.language, 'German');
    assert.deepEqual(body.advancedOptions.emoji, ['auto', 'none', 'some']);
    assert.equal((await fetch(url, { method: 'PUT', body: JSON.stringify({ text: '', advanced: { tone: 'loud' } }) })).status, 400);
  } finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
