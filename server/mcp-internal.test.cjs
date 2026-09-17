const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mcp = require('./mcp.cjs');
const internal = require('./mcp-internal.cjs');

const KEY = crypto.randomBytes(32);
const OTHER_KEY = crypto.randomBytes(32);

const DEFS = {
  demo_read: { description: 'Read something.', schema: { type: 'object', properties: { q: { type: 'string' } }, required: [] },
    handler: async (args, ctx) => `read ${args.q || ''} as ${ctx.userId}/${ctx.projectId}` },
  demo_write: { description: 'Write something.', write: true, schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    handler: async (args, ctx) => `wrote ${args.text} as ${ctx.userId}` },
};

const call = (name, args) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

function handler() { return internal.createHandler({ key: KEY, definitions: DEFS }); }

test('a token proves who the call acts for, and nothing else can set that', async () => {
  const handle = handler();
  const token = internal.mintToken(KEY, { uid: 'alice', pid: 'proj-a' });
  // The model supplies userId/projectId/tenant arguments. They are ignored:
  // identity comes from the verified token only.
  const out = await handle(call('demo_read', { q: 'x', userId: 'bob', projectId: 'proj-b', tenant: 'bob' }), token);
  assert.equal(out.status, 200);
  assert.match(out.body.result.content[0].text, /as alice\/proj-a$/);
});

test('tampered, wrong-key, expired and malformed tokens are all rejected', async () => {
  const handle = handler();
  const good = internal.mintToken(KEY, { uid: 'alice' });

  const [body, sig] = good.split('.');
  const swapped = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), uid: 'bob' })).toString('base64url');
  for (const bad of [
    `${swapped}.${sig}`,                                   // claims edited, old signature
    internal.mintToken(OTHER_KEY, { uid: 'alice' }),        // signed with another key
    internal.mintToken(KEY, { uid: 'alice', ttlMs: -1 }),   // already expired
    'not-a-token', '', `${body}.`, `${body}.${sig}.${sig}`,
  ]) {
    const out = await handle(call('demo_read', {}), bad);
    assert.equal(out.status, 401, `accepted ${JSON.stringify(String(bad).slice(0, 24))}`);
  }
  // …and the genuine one still works, so the test is not passing vacuously.
  assert.equal((await handle(call('demo_read', {}), good)).status, 200);
});

test('a write presented without the approved capability fails closed', async () => {
  const handle = handler();
  const unapproved = internal.mintToken(KEY, { uid: 'alice', w: 0 });
  const out = await handle(call('demo_write', { text: 'hi' }), unapproved);
  assert.equal(out.status, 403);
  assert.match(out.body.error.message, /was not approved/);

  const approved = internal.mintToken(KEY, { uid: 'alice', w: 1 });
  const ok = await handle(call('demo_write', { text: 'hi' }), approved);
  assert.equal(ok.status, 200);
  assert.match(ok.body.result.content[0].text, /^wrote hi/);
});

test('a discovery token lists tools but can never call one', async () => {
  const handle = handler();
  const discovery = internal.mintToken(KEY, { discovery: true });
  const listed = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, discovery);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.result.tools.map((t) => t.name).sort(), ['demo_read', 'demo_write']);

  const denied = await handle(call('demo_read', {}), discovery);
  assert.equal(denied.status, 403);
  // Even a write capability on a discovery token does not unlock calling.
  const armed = internal.mintToken(KEY, { discovery: true, w: 1 });
  assert.equal((await handle(call('demo_write', { text: 'x' }), armed)).status, 403);
});

test('a captured token cannot repeat the call, but still completes its own session', async () => {
  const handle = handler();
  const token = internal.mintToken(KEY, { uid: 'alice', w: 1 });
  // mcp.cjs opens a session before calling, so initialize must not burn it.
  assert.equal((await handle({ jsonrpc: '2.0', id: 1, method: 'initialize' }, token)).status, 200);
  assert.equal((await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, token)).status, 200);
  assert.equal((await handle(call('demo_write', { text: 'once' }), token)).status, 200);
  const replay = await handle(call('demo_write', { text: 'twice' }), token);
  assert.equal(replay.status, 401);
  assert.match(replay.body.error.message, /already been used/);
});

test('a handler that throws becomes a tool error, not a dead stream', async () => {
  const handle = internal.createHandler({ key: KEY, definitions: {
    boom: { description: 'x', handler: async () => { throw new Error('nope'); } },
  } });
  const out = await handle(call('boom', {}), internal.mintToken(KEY, { uid: 'alice' }));
  assert.equal(out.status, 200);
  assert.equal(out.body.result.isError, true);
  assert.match(out.body.result.content[0].text, /ERROR: nope/);
});

test('an unknown tool is a tool error the model can read, not a protocol failure', async () => {
  const out = await handler()(call('no_such_tool', {}), internal.mintToken(KEY, { uid: 'alice' }));
  assert.equal(out.status, 200);
  assert.match(out.body.result.content[0].text, /unknown tool/);
});

test('every catalogue entry survives mcp.convertTool', () => {
  // llama.cpp builds a grammar per tool schema and rejects the WHOLE request
  // on one it cannot resolve, so a bad schema here would silently break every
  // other tool in the box.
  for (const tool of internal.catalogueOf(DEFS)) {
    const conv = mcp.convertTool(tool);
    assert.ok(conv.ok, `${tool.name}: ${conv.reason}`);
    assert.equal(mcp.readOnlyHint(tool), !DEFS[tool.name].write);
  }
});

test('the scope a handler runs in comes from the token, not from ambient state', async () => {
  // Found by the HTTP suite: the handlers reach the workspace through the same
  // ambient AsyncLocalStorage the routes use, so without runAs the token's uid
  // is decoration and whichever request happens to be in flight decides whose
  // files get read. This asserts the token wins.
  const { AsyncLocalStorage } = require('node:async_hooks');
  const scope = new AsyncLocalStorage();
  const handle = internal.createHandler({
    key: KEY,
    definitions: { whoami: { description: 'x', handler: async () => `scope=${scope.getStore()}` } },
    runAs: (userId, fn) => scope.run(userId, fn),
  });

  // Run the call while an unrelated user's scope is active on this stack.
  const out = await scope.run('mallory', () => handle(call('whoami', {}), internal.mintToken(KEY, { uid: 'alice' })));
  assert.equal(out.body.result.content[0].text, 'scope=alice');
});

test('a token for an account that no longer exists cannot act', async () => {
  const handle = internal.createHandler({
    key: KEY,
    definitions: DEFS,
    runAs: () => { throw new Error('that account no longer exists'); },
  });
  const out = await handle(call('demo_read', {}), internal.mintToken(KEY, { uid: 'deleted' }));
  assert.equal(out.body.result.isError, true);
  assert.match(out.body.result.content[0].text, /no longer exists/);
});
