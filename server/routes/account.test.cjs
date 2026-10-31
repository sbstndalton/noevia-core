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
    // #1071: the preview GET is the Rust front's; were one to reach this module it is not answered.
    const got = await fetch(url);
    assert.equal(got.status, 405); assert.deepEqual(await got.json(), { error: 'method not allowed' });
    let r = await put({ days: 90 });
    assert.equal(r.status, 409); assert.deepEqual(removed, []);
    assert.deepEqual(r.body.preview, { 30: 1, 90: 1, 365: 0 }, 'the refusal carries the preview the GET used to');
    assert.equal(fs.existsSync(path.join(dir, 'chat-retention.json')), false, 'nothing saved');
    r = await put({ days: 90, confirmDeletes: 1 });
    assert.equal(r.status, 200); assert.equal(r.body.deleted, 1); assert.deepEqual(removed, ['old']);
    assert.equal((await put({ days: 0 })).status, 200);
  } finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// sbstndalton/noevia#1071: custom instructions, memory and interface preferences are the Rust
// front's (noevia-rs crates/server-account); rust-auth.cjs refuses them before this module runs, and
// the module no longer handles them.
test('instructions, memory and preferences are not handled here, whatever the method', async () => {
  const json = () => assert.fail('nothing is answered');
  const readJson = async () => assert.fail('no body is read');
  const routes = createAccountRoutes({ json, readJson, dir: () => assert.fail('no account directory is touched') });
  for (const path of ['/api/account/instructions', '/api/account/memory', '/api/account/preferences']) {
    for (const method of ['GET', 'PUT', 'POST', 'DELETE']) {
      for (const authn of [null, { user: { id: 'u' } }]) {
        assert.equal(await routes({ method }, {}, { path, authn }), false, `${method} ${path}`);
      }
    }
  }
});

// sbstndalton/noevia#2230: the 200 means the chats are gone. removeChat is a promise (the store's
// transcript delete runs under a lock); answering before it settled let a history read right
// after the PUT still return the transcript.
test('retention PUT answers only after every removal settled (#2230)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-routes-'));
  const NOW = Date.UTC(2026, 8, 17);
  const old = NOW - 200 * 86400000;
  const free = [{ id: 'a', updatedAt: old }, { id: 'b', projectId: 'p', updatedAt: old }];
  const transcripts = new Set(['a', 'b']);
  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const readJson = async (req) => { let raw = ''; for await (const c of req) raw += c; return JSON.parse(raw); };
  const removeChat = async (c) => { await new Promise((r) => setTimeout(r, 60)); transcripts.delete(c.id); return true; };
  const routes = createAccountRoutes({ json, readJson, dir: () => dir, now: () => NOW, chatLists: () => ({ freeChats: free.filter((c) => !c.projectId), projects: [{ id: 'p', chats: free.filter((c) => c.projectId) }] }), removeChat });
  const server = http.createServer((req, res) => void routes(req, res, { path: req.url, authn: { user: { id: 'u' } } }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/account/retention`, { method: 'PUT', body: JSON.stringify({ days: 90, confirmDeletes: 2 }) });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { days: 90, deleted: 2 });
    assert.deepEqual([...transcripts], [], 'no transcript is readable once the PUT has answered');
  } finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('retention PUT reports a chat whose removal failed instead of counting it (#2230)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-routes-'));
  const NOW = Date.UTC(2026, 8, 17);
  const old = NOW - 200 * 86400000;
  const free = [{ id: 'a', updatedAt: old }, { id: 'b', updatedAt: old }];
  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const readJson = async (req) => { let raw = ''; for await (const c of req) raw += c; return JSON.parse(raw); };
  const removeChat = async (c) => { if (c.id === 'a') throw Object.assign(new Error('internal path /x'), { status: 503 }); return true; };
  const routes = createAccountRoutes({ json, readJson, dir: () => dir, now: () => NOW, chatLists: () => ({ freeChats: free, projects: [] }), removeChat });
  const server = http.createServer((req, res) => void routes(req, res, { path: req.url, authn: { user: { id: 'u' } } }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/account/retention`, { method: 'PUT', body: JSON.stringify({ days: 90, confirmDeletes: 2 }) });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.deleted, 0, 'it stops at the first busy store');
    assert.doesNotMatch(JSON.stringify(body), /\/x/);
  } finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

function retentionServer({ removeChat, clock, deadlineMs }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-routes-'));
  const NOW = Date.UTC(2026, 8, 17), old = NOW - 200 * 86400000;
  const free = [1, 2, 3].map((n) => ({ id: 'c' + n, updatedAt: old }));
  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const readJson = async (req) => { let raw = ''; for await (const c of req) raw += c; return JSON.parse(raw); };
  const routes = createAccountRoutes({ json, readJson, dir: () => dir, now: () => NOW, clock, deadlineMs, chatLists: () => ({ freeChats: free, projects: [] }), removeChat });
  const server = http.createServer((req, res) => void routes(req, res, { path: req.url, authn: { user: { id: 'u' } } }));
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({
    dir, server,
    put: () => fetch(`http://127.0.0.1:${server.address().port}/api/account/retention`, { method: 'PUT', body: JSON.stringify({ days: 90, confirmDeletes: 3 }) }),
    swept: () => fs.existsSync(path.join(dir, 'chat-retention.json')) && JSON.parse(fs.readFileSync(path.join(dir, 'chat-retention.json'), 'utf8')).lastSweep,
    close() { server.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  })));
}

test('retention PUT stops at the first busy store and leaves the sweep armed (#2230)', async () => {
  const calls = [];
  const f = await retentionServer({ removeChat: async (c) => { calls.push(c.id); throw Object.assign(new Error('busy'), { status: 503 }); } });
  try {
    const res = await f.put();
    assert.equal(res.status, 503);
    assert.deepEqual(calls, ['c1'], 'no further chat is tried');
    assert.ok(!f.swept());
  } finally { f.close(); }
});

test('retention PUT stops at its deadline and does not claim the rest (#2230)', async () => {
  let t = 0; const calls = [];
  const f = await retentionServer({ clock: () => t, deadlineMs: 30000, removeChat: async (c) => { calls.push(c.id); t += 20000; return true; } });
  try {
    const res = await f.put();
    assert.equal(res.status, 503);
    assert.deepEqual(calls, ['c1', 'c2'], 'the third is past 30 s');
    assert.equal((await res.json()).deleted, 2);
    assert.ok(!f.swept());
  } finally { f.close(); }
});

test('a chat the store skipped (false) leaves the sweep armed (#2230)', async () => {
  const f = await retentionServer({ removeChat: async (c) => c.id !== 'c2' });
  try {
    const res = await f.put();
    assert.equal(res.status, 200);
    assert.equal((await res.json()).deleted, 2);
    assert.ok(!f.swept());
  } finally { f.close(); }
});
