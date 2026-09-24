'use strict';
// createMcpWiring with a fake protocol client: discovery, the credential each
// server mode gets, and what the executor refuses. No network, no server boot.
const test = require('node:test');
const assert = require('node:assert/strict');
const { AsyncLocalStorage } = require('node:async_hooks');
const { createMcpWiring, createDirectoryUrlAllowed, createCredentialOriginCheck, parseNextcloudOrigins } = require('./mcp-wiring.cjs');

const rawTool = (name, readOnly) => ({ name, description: name, inputSchema: { type: 'object', properties: {} }, annotations: readOnly === undefined ? undefined : { readOnlyHint: readOnly } });

function fakeMcp(catalogues) {
  const calls = [];
  const sessions = [];
  return {
    calls, sessions,
    async connect(url, headers, _timeoutMs, signal) { sessions.push({ url, headers, open: true, connectSignal: signal }); return { session: sessions.length - 1 }; },
    async disconnect(_url, session) { sessions[session].open = false; },
    async listTools(url) { if (catalogues[url] instanceof Error) throw catalogues[url]; return catalogues[url] || []; },
    async callTool(url, _session, name, args, headers, _timeoutMs, signal) { calls.push({ url, name, args, headers, signal }); return { content: [{ type: 'text', text: `${name}:${JSON.stringify(args)}` }] }; },
    convertTool(t) { return { ok: true, tool: { type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } } }; },
    readOnlyHint(t) { return t.annotations ? t.annotations.readOnlyHint : undefined; },
    resultToText(r) { return r.content.map((c) => c.text).join(''); },
  };
}

function build({ servers, catalogues, directoryServers = [], env = {}, storage = { kind: 'local' }, origins = '', manifest = [] } = {}) {
  const mcp = fakeMcp(catalogues);
  const scope = new AsyncLocalStorage();
  const minted = [];
  const wiring = createMcpWiring({
    servers, manifest, mcp,
    bindBoxes: ({ manifest, perServer }) => manifest.map((m) => ({ id: m.id, tools: [...(perServer.get(m.server) || new Map()).values()].map((e) => e.tool), server: m.server })),
    directoryMcp: { asServers: () => directoryServers, boxFor: (sv, names) => ({ id: sv.id, server: sv.id, tools: [...names] }), headersFor: () => ({ 'X-Key': 'dir' }), userHeadersFor: (uid) => (uid === 'keyed' ? { 'X-Key': 'mine' } : {}), hasUserKey: (uid) => uid === 'keyed' },
    mcpOAuth: { connected: (uid) => uid === 'signed', tokenFor: async (uid) => (uid === 'signed' ? 'oauth-token' : null) },
    directoryUrlAllowed: async (url) => !url.includes('private'),
    credentialOriginAllowed: createCredentialOriginCheck(origins),
    scope, storageFor: () => storage, isWriteTool: (name) => name.endsWith('_write'),
    internal: { mintToken: (_k, claims) => { minted.push(claims); return 'cap' } }, internalKey: 'k',
    reduceToolResult: (text) => ({ text, reduced: false }), env, logger: { log() {}, warn() {} },
  });
  return { wiring, mcp, scope, minted };
}

const asUser = (scope, userId, fn) => scope.run({ workspace: { userId }, authn: { user: { id: userId } } }, fn);

test('discovery is per server: a dead server loses its tools, a healthy one keeps them, and the first name wins', async () => {
  const servers = [{ id: 'nc', url: 'http://nc/mcp', auth: 'bearer', tokenEnv: 'NC_TOKEN' }, { id: 'dead', url: 'http://dead/mcp', auth: 'bearer', tokenEnv: 'NC_TOKEN' }, { id: 'other', url: 'http://other/mcp', auth: 'bearer', tokenEnv: 'NC_TOKEN' }];
  const { wiring, mcp } = build({ servers, env: { NC_TOKEN: 't' }, manifest: [{ id: 'nc-box', server: 'nc' }], catalogues: { 'http://nc/mcp': [rawTool('search', true)], 'http://dead/mcp': new Error('ECONNREFUSED'), 'http://other/mcp': [rawTool('search', false)] } });
  assert.equal(wiring.enabled(), true);
  const state = await wiring.discoverMcpTools();
  assert.deepEqual([...state.tools.keys()], ['search']);
  assert.equal(state.tools.get('search').serverId, 'nc', 'declaration order breaks the tie');
  assert.equal(state.servers.get('dead').error, 'ECONNREFUSED');
  assert.equal(state.servers.get('nc').toolCount, 1);
  assert.equal(state.error, 'ECONNREFUSED');
  assert.deepEqual(state.boxes.map((b) => b.id), ['nc-box']);
  assert.ok(mcp.sessions.every((s) => !s.open), 'every discovery session is closed');
  // Cached: a second call within the TTL does not go back to the network. (The cache only
  // holds once a box exists, so an empty catalogue is retried on the next request.)
  const before = mcp.sessions.length;
  await wiring.discoverMcpTools();
  assert.equal(mcp.sessions.length, before);
  await wiring.discoverMcpTools(true);
  assert.equal(mcp.sessions.length, before + 3, 'a forced refresh discovers every server again');
});

test('with no servers nothing is offered and discovery is a no-op', async () => {
  const { wiring, mcp } = build({ servers: [], catalogues: {} });
  assert.equal(wiring.enabled(), false);
  const state = await wiring.discoverMcpTools();
  assert.equal(state.tools.size, 0);
  assert.equal(mcp.sessions.length, 0);
});

test('directory servers join the list after the operator ones and sync replaces only them', () => {
  const servers = [{ id: 'op', url: 'http://op/mcp', auth: 'bearer' }];
  const dir = [{ id: 'd1', url: 'https://d1.example/mcp', auth: 'directory', directory: true }];
  const { wiring } = build({ servers, catalogues: {}, directoryServers: dir });
  assert.deepEqual(wiring.servers.map((s) => s.id), ['op', 'd1']);
  dir.splice(0, 1, { id: 'd2', url: 'https://d2.example/mcp', auth: 'directory', directory: true });
  wiring.syncDirectoryServers();
  assert.deepEqual(wiring.servers.map((s) => s.id), ['op', 'd2']);
  assert.equal(wiring.accountReady('anyone', 'd2'), true);
  assert.equal(wiring.accountReady('anyone', 'gone'), false);
});

test('each server mode gets exactly its own credential, and a missing one is an actionable error', async () => {
  const servers = [
    { id: 'nc', url: 'http://nc/mcp', auth: 'nextcloud' },
    { id: 'b', url: 'http://b/mcp', auth: 'bearer', tokenEnv: 'B_TOKEN' },
    { id: 'p', url: 'http://p/mcp', auth: 'personal', title: 'Personal', addedBy: 'keyed' },
    { id: 'o', url: 'http://o/mcp', auth: 'oauth', title: 'OAuth', addedBy: 'signed' },
    { id: 'i', url: 'http://127.0.0.1:9/mcp', auth: 'internal' },
  ];
  const catalogues = { 'http://nc/mcp': [rawTool('nc_read')], 'http://b/mcp': [rawTool('b_read')], 'http://p/mcp': [rawTool('p_read')], 'http://o/mcp': [rawTool('o_read')], 'http://127.0.0.1:9/mcp': [rawTool('i_write')] };
  const { wiring, mcp, scope, minted } = build({ servers, catalogues, env: { B_TOKEN: 'secret' }, storage: { kind: 'webdav', baseUrl: 'https://cloud.example/remote.php', username: 'u', secret: 'p' }, origins: 'https://cloud.example' });
  await wiring.discoverMcpTools();
  assert.equal(wiring.state.tools.size, 5);
  // Discovery credentials: bearer from env, internal a discovery-only token, none for user modes' listing.
  assert.deepEqual(mcp.sessions.find((s) => s.url === 'http://b/mcp').headers, { Authorization: 'Bearer secret' });
  assert.ok(minted.some((c) => c.discovery === true && c.ttlMs === 120000));

  // The chat's own abort signal (browser disconnect) travels through to the
  // underlying connect/callTool, so a tool call stops when the caller goes
  // away instead of running for the full internal timeout regardless.
  const chatController = new AbortController();
  const withSignal = await asUser(scope, 'alice', () => wiring.executeMcpToolCall('nc_read', { q: 1 }, chatController.signal));
  assert.equal(withSignal, 'nc_read:{"q":1}');
  assert.equal(mcp.sessions.filter((s) => s.url === 'http://nc/mcp').at(-1).connectSignal, chatController.signal);
  assert.equal(mcp.calls.find((c) => c.name === 'nc_read').signal, chatController.signal);

  const run = (uid, name) => asUser(scope, uid, () => wiring.executeMcpToolCall(name, { q: 1 }));
  assert.equal(await run('alice', 'nc_read'), 'nc_read:{"q":1}');
  const ncCall = mcp.calls.find((c) => c.name === 'nc_read');
  assert.equal(ncCall.headers.Authorization, 'Basic ' + Buffer.from('u:p').toString('base64'));
  assert.equal(ncCall.headers['X-Cowork-User-ID'], 'alice');
  assert.equal(await run('alice', 'b_read'), 'b_read:{"q":1}');
  assert.deepEqual(mcp.calls.find((c) => c.name === 'b_read').headers, { Authorization: 'Bearer secret' });
  assert.match(await run('nobody', 'p_read'), /^ERROR: p_read needs your own key for Personal/);
  assert.equal(await run('keyed', 'p_read'), 'p_read:{"q":1}');
  assert.deepEqual(mcp.calls.find((c) => c.name === 'p_read').headers, { 'X-Key': 'mine' });
  assert.match(await run('nobody', 'o_read'), /^ERROR: o_read needs you to sign in to OAuth first/);
  assert.equal(await run('signed', 'o_read'), 'o_read:{"q":1}');
  assert.deepEqual(mcp.calls.find((c) => c.name === 'o_read').headers, { Authorization: 'Bearer oauth-token' });
  // Internal: the capability token names the user, the project in scope and whether it is a write.
  await scope.run({ workspace: { userId: 'alice' }, authn: { user: { id: 'alice' } }, internalCallProject: { id: 'proj' } }, () => wiring.executeMcpToolCall('i_write', {}));
  assert.deepEqual(minted.at(-1), { uid: 'alice', pid: 'proj', w: 1 });
  assert.equal(await wiring.executeMcpToolCall('i_write', {}), 'ERROR: i_write needs a signed-in session and there is none.');
  assert.ok(mcp.sessions.every((s) => !s.open), 'every call session is closed, even after a refusal');
});

test("a user's Nextcloud credential is never forwarded to an origin the operator did not list", async () => {
  const servers = [{ id: 'nc', url: 'http://nc/mcp', auth: 'nextcloud' }];
  const { wiring, scope, mcp } = build({ servers, catalogues: { 'http://nc/mcp': [rawTool('nc_read')] }, storage: { kind: 'nextcloud', baseUrl: 'https://elsewhere.example', username: 'u', secret: 'p' }, origins: 'https://cloud.example' });
  await wiring.discoverMcpTools();
  const out = await asUser(scope, 'alice', () => wiring.executeMcpToolCall('nc_read', {}));
  assert.match(out, /^ERROR: this tool needs your Nextcloud account/);
  assert.equal(mcp.calls.length, 0);
  assert.equal(wiring.mcpAuthHeaders(), null, 'no request scope, no credential');
});

test('a bearer server whose token is not configured is refused by name, and an unknown tool by name', async () => {
  const servers = [{ id: 'b', url: 'http://b/mcp', auth: 'bearer', tokenEnv: 'MISSING_TOKEN' }];
  const { wiring, scope } = build({ servers, catalogues: { 'http://b/mcp': [rawTool('b_read')] } });
  await wiring.discoverMcpTools();
  assert.equal(await asUser(scope, 'a', () => wiring.executeMcpToolCall('b_read', {})), 'ERROR: b_read needs MISSING_TOKEN, which is not configured on this deployment.');
  assert.equal(await wiring.executeMcpToolCall('nope', {}), 'ERROR: unknown tool "nope"');
});

test('a directory server that stops resolving to a public host is dropped at discovery and refused at call time', async () => {
  const dir = [{ id: 'd', url: 'https://private.example/mcp', auth: 'directory', directory: true }];
  const { wiring } = build({ servers: [], catalogues: {}, directoryServers: dir });
  const state = await wiring.discoverMcpTools();
  assert.equal(state.servers.get('d').error, 'its address no longer resolves to a public host');
  assert.equal(state.tools.size, 0);
});

test('the pure helpers: loopback only for QA, origins parsed with trailing slashes stripped', async () => {
  const strict = createDirectoryUrlAllowed({ isPublicUrl: async () => false });
  const qa = createDirectoryUrlAllowed({ isPublicUrl: async () => false, allowLoopback: true });
  assert.equal(await strict('http://127.0.0.1:8080/mcp'), false);
  assert.equal(await qa('http://127.0.0.1:8080/mcp'), true);
  assert.equal(await qa('http://10.0.0.2:8080/mcp'), false);
  assert.deepEqual(parseNextcloudOrigins(' https://a.example/, http://10.0.0.1:11000 ,,'), ['https://a.example', 'http://10.0.0.1:11000']);
  const allowed = createCredentialOriginCheck('https://a.example');
  assert.equal(allowed('https://a.example/remote.php/dav'), true);
  assert.equal(allowed('https://b.example/'), false);
  assert.equal(allowed('not a url'), false);
});
