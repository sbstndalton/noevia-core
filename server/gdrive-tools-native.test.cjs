'use strict';
// Track R5: with NOEVIA_RUST_DRIVE_TOOLS on, the chat's Drive tools and the approval card's target are the Rust
// front's (POST /v1/gdrive/tool and /target, noevia-rs gdrive_tools.rs). This process sends the account and the
// call, keeps nothing (the read records are the front's), and falls back to its own path only when the front
// says it runs no Drive tools (404). Fakes only; no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDriveTools } = require('./gdrive-tools.cjs');

function build({ enabled = true, tool = () => ({ status: 200, body: { text: 'qa from the front' } }), target = () => ({ status: 200, body: { target: { target: 'QA f1.txt (id f1)', kind: 'drive' } } }) } = {}) {
  const asked = [];
  const own = [];
  const drive = {
    state: () => ({ state: 'connected' }),
    api: 'http://drive.test', upload: 'http://upload.test',
    async call(url) { own.push(url); return { files: [] }; },
    async request(url) { own.push(url); return new Response('qa'); },
  };
  const accounts = { forUser: () => ({ drive }) };
  const warnings = [];
  const tools = createDriveTools({ accounts, cap: 8000, warn: (m) => warnings.push(m),
    native: { enabled: () => enabled, async tool(p) { asked.push({ kind: 'tool', p }); return tool(p); }, async target(p) { asked.push({ kind: 'target', p }); return target(p); } } });
  return { tools, asked, own, warnings };
}

const member = { id: 'user-1', role: 'member' };

test('switched off, the tools are this process own and the front is never asked', async () => {
  const b = build({ enabled: false });
  assert.equal(await b.tools.execute(member, 'drive_list_recent', {}), 'No files yet. noevia only sees files it created or was given in this Drive.');
  assert.equal(b.asked.length, 0);
  assert.equal(b.own.length, 1);
});

test('switched on, a call is the front own, with the account, the scope and the cap', async () => {
  const b = build();
  assert.equal(await b.tools.execute(member, 'drive_read_file', { fileId: 'f1' }, { chatKey: 'chat-1', exchangeKey: 'ex-1' }), 'qa from the front');
  assert.deepEqual(b.asked[0].p, { user: 'user-1', admin: false, name: 'drive_read_file', arguments: { fileId: 'f1' }, chatKey: 'chat-1', exchangeKey: 'ex-1', cap: 8000 });
  assert.equal(b.own.length, 0, 'nothing from this process');
  await b.tools.execute({ id: 'admin-1', role: 'admin' }, 'drive_list_recent', undefined);
  assert.deepEqual(b.asked[1].p, { user: 'admin-1', admin: true, name: 'drive_list_recent', arguments: {}, chatKey: null, exchangeKey: null, cap: 8000 });
  await b.tools.execute(null, 'drive_list_recent', {});
  assert.equal(b.asked[2].p.user, null, 'no account: the front says to sign in');
});

test('the approval card target is the front own, and only a well-formed one is shown', async () => {
  const b = build();
  assert.deepEqual(await b.tools.describeTarget(member, 'drive_trash_file', '{"fileId":"f1"}'), { target: 'QA f1.txt (id f1)', kind: 'drive' });
  assert.deepEqual(b.asked[0].p, { user: 'user-1', admin: false, name: 'drive_trash_file', arguments: '{"fileId":"f1"}' });
  assert.equal(await b.tools.describeTarget(member, 'drive_read_file', { fileId: 'f1' }), null, 'a read has no card: not asked');
  assert.equal(b.asked.length, 1);
  for (const [target, want] of [[null, null], [{ error: 'Google Drive is not connected for this account' }, { error: 'Google Drive is not connected for this account' }],
    [{ target: 'x' }, { error: 'Google Drive could not be reached' }], [5, { error: 'Google Drive could not be reached' }]]) {
    const c = build({ target: () => ({ status: 200, body: { target } }) });
    assert.deepEqual(await c.tools.describeTarget(member, 'drive_update_file', { fileId: 'f1' }), want);
  }
  const d = build({ target: () => ({ status: 503, body: {} }) });
  assert.deepEqual(await d.tools.describeTarget(member, 'drive_update_file', { fileId: 'f1' }), { error: 'Google Drive could not be reached' });
});

test('a front that runs no Drive tools (404) leaves them to this process, which then stops asking', async () => {
  const b = build({ tool: () => ({ status: 404, body: { error: 'not found' } }), target: () => ({ status: 404, body: {} }) });
  assert.equal(await b.tools.execute(member, 'drive_list_recent', {}), 'No files yet. noevia only sees files it created or was given in this Drive.');
  assert.equal(await b.tools.execute(member, 'drive_list_recent', {}), 'No files yet. noevia only sees files it created or was given in this Drive.');
  assert.equal(b.asked.length, 1, 'asked once');
  assert.equal(b.warnings.length, 1);
});

test('an answer is worded by what is known: not reached, refused, or possibly run', async () => {
  const UNAVAILABLE = 'ERROR: Google Drive is unavailable right now. Try again in a moment.';
  const UNKNOWN = 'ERROR: the Google Drive tool did not report back, so it may or may not have run. Check before calling it again.';
  const cases = [
    [() => { throw Object.assign(new Error('busy'), { code: 'PROJECTS_BUSY', cause: new TypeError('fetch failed') }); }, UNAVAILABLE],
    [() => { throw Object.assign(new Error('busy'), { code: 'PROJECTS_BUSY', cause: Object.assign(new Error('t'), { name: 'TimeoutError' }) }); }, UNKNOWN],
    [() => ({ status: 400, body: { error: 'invalid name' } }), UNAVAILABLE],
    [() => ({ status: 503, body: { error: 'unavailable' } }), UNAVAILABLE],
    [() => ({ status: 500, body: {} }), UNKNOWN],
    [() => ({ status: 200, body: { text: 5 } }), UNKNOWN],
    [() => ({ status: 200, body: null }), UNKNOWN],
  ];
  for (const [tool, want] of cases) {
    const b = build({ tool });
    assert.equal(await b.tools.execute(member, 'drive_update_file', { fileId: 'f1', content: 'x' }), want);
    assert.equal(b.own.length, 0, 'never run here on a guess');
  }
});

test('the store client sends the Drive calls to the front', async () => {
  const { createClient } = require('./project-store-client.cjs');
  const seen = [];
  const client = createClient({ port: 4567, token: 't'.repeat(32), fetchImpl: async (url, init) => {
    seen.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ text: 'qa' }), { status: 200, headers: { 'content-type': 'application/json' } });
  } });
  assert.deepEqual(await client.gdriveTool({ name: 'drive_list_recent' }), { status: 200, body: { text: 'qa' } });
  await client.gdriveTarget({ name: 'drive_trash_file' });
  assert.deepEqual(seen.map((s) => s.url), ['http://127.0.0.1:4567/v1/gdrive/tool', 'http://127.0.0.1:4567/v1/gdrive/target']);
});
