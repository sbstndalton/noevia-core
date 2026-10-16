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
