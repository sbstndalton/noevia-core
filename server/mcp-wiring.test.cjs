'use strict';
// createMcpWiring with a fake protocol client: discovery, the credential discovery uses, and the client of the Rust
// front's executor (what a call carries, and that it fails closed). The executor's behaviour is the front's and is
// tested there against core's frozen oracle (tests/fixtures/mcp-exec.v1.json). No network, no server boot.
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
    async disconnect(_url, session, _headers, _timeoutMs, signal) { sessions[session].open = false; sessions[session].disconnectSignal = signal; },
    async listTools(url) { if (catalogues[url] instanceof Error) throw catalogues[url]; return catalogues[url] || []; },
    async callTool(url, _session, name, args, headers, _timeoutMs, signal) { calls.push({ url, name, args, headers, signal }); return { content: [{ type: 'text', text: `${name}:${JSON.stringify(args)}` }] }; },
    convertTool(t) { return { ok: true, tool: { type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } } }; },
    readOnlyHint(t) { return t.annotations ? t.annotations.readOnlyHint : undefined; },
    resultToText(r) { return r.content.map((c) => c.text).join(''); },
  };
}

function build({ servers, catalogues, directoryServers = [], env = {}, storage = { kind: 'local' }, origins = '', manifest = [], isUserDisabled, discoveryFailTtlMs, discoveryTtlMs, discoveryRetryMs, mcpOAuth, mcpKeys, mcpExec, mcp: mcpOverride } = {}) {
  const mcp = mcpOverride || fakeMcp(catalogues);
  const scope = new AsyncLocalStorage();
  const minted = [];
  // The directory is the Rust front's table, re-read through `signal` (directory-mcp.cjs): a test moves it by bumping `version`.
  const dirState = { version: 0, servers: directoryServers, looks: 0 };
  const wiring = createMcpWiring({
    servers, manifest, mcp,
    bindBoxes: ({ manifest, perServer }) => manifest.map((m) => ({ id: m.id, tools: [...(perServer.get(m.server) || new Map()).values()].map((e) => e.tool), server: m.server })),
    directoryCheckMs: 0,
    directoryMcp: { signal: () => { dirState.looks += 1; return dirState.version; }, asServers: () => dirState.servers, boxFor: (sv, names) => ({ id: sv.id, server: sv.id, tools: [...names] }), headersFor: () => ({ 'X-Key': 'dir' }) },
    // The brokers (rust-mcp-credentials.cjs): one call's key headers / access token, asked per call.
    mcpKeys: mcpKeys || { hasKey: (uid) => uid === 'keyed', headers: async (uid) => (uid === 'keyed' ? { 'X-Key': 'mine' } : null) },
    mcpOAuth: mcpOAuth || { connected: (uid) => uid === 'signed', tokenFor: async (uid) => (uid === 'signed' ? 'oauth-token' : null) },
    directoryUrlAllowed: async (url) => !url.includes('private'),
    scope, isWriteTool: (name) => name.endsWith('_write'), ...(mcpExec ? { mcpExec } : {}),
    internal: { mintToken: (_k, claims) => { minted.push(claims); return 'cap' } }, internalKey: 'k',
    env, logger: { log() {}, warn() {} },
    ...(isUserDisabled ? { isUserDisabled } : {}),
    ...(discoveryFailTtlMs !== undefined ? { discoveryFailTtlMs } : {}),
    ...(discoveryTtlMs !== undefined ? { discoveryTtlMs } : {}),
    ...(discoveryRetryMs !== undefined ? { discoveryRetryMs } : {}),
  });
  return { wiring, mcp, scope, minted, dirState };
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

test('a discovery where every server fails is still cached for the failure TTL, and a forced refresh bypasses it', async () => {
  const servers = [{ id: 'a', url: 'http://a/mcp', auth: 'bearer', tokenEnv: 'T' }, { id: 'b', url: 'http://b/mcp', auth: 'bearer', tokenEnv: 'T' }];
  const { wiring, mcp } = build({
    servers, env: { T: 't' }, discoveryFailTtlMs: 30000,
    catalogues: { 'http://a/mcp': new Error('ECONNREFUSED'), 'http://b/mcp': new Error('ECONNREFUSED') },
  });
  const state1 = await wiring.discoverMcpTools();
  assert.equal(state1.boxes.length, 0);
  const afterFirst = mcp.sessions.length;
  assert.ok(afterFirst > 0, 'the first call actually connects');

  // Within the TTL, an unforced call (what GET /api/toolboxes issues) must not reconnect.
  await wiring.discoverMcpTools();
  assert.equal(mcp.sessions.length, afterFirst, 'a second unforced call within the TTL is served from the cached failure');

  // Forced discovery (admin add/remove, OAuth finish) bypasses the TTL regardless.
  await wiring.discoverMcpTools(true);
  assert.equal(mcp.sessions.length, afterFirst * 2, 'a forced refresh always reconnects to every server');
});

// #1081: a remote server that fails its first discovery (fetch failed before DNS was up) was hidden
// for the whole 10-minute TTL. It is now retried on a short backoff, and a healthy discovery keeps the TTL.
test('#1081: a remote server that failed discovery is retried on the short backoff and offered once it answers', async () => {
  const servers = [{ id: 'tavily', url: 'http://t/mcp', auth: 'none' }, { id: 'nc', url: 'http://n/mcp', auth: 'none' }];
  const catalogues = { 'http://t/mcp': new Error('fetch failed'), 'http://n/mcp': [rawTool('nc_list')] };
  const manifest = [{ id: 'web-search', server: 'tavily', tools: ['tavily_search'] }, { id: 'nextcloud', server: 'nc', tools: ['nc_list'] }];
  const { wiring, mcp } = build({ servers, catalogues, manifest, discoveryTtlMs: 10 * 60 * 1000, discoveryRetryMs: [0] });
  const first = await wiring.discoverMcpTools();
  assert.match(first.servers.get('tavily').error, /fetch failed/);
  assert.equal(first.boxes.find((b) => b.id === 'web-search').tools.length, 0, 'the failed server offers nothing yet');
  assert.equal(first.boxes.find((b) => b.id === 'nextcloud').tools.length, 1, 'the healthy server is offered at once');

  catalogues['http://t/mcp'] = [rawTool('tavily_search', true)];
  const second = await wiring.discoverMcpTools();
  assert.equal(second.servers.get('tavily').error, null);
  assert.equal(second.boxes.find((b) => b.id === 'web-search').tools.length, 1, 'the next unforced request retries it, without waiting for the TTL');
  assert.ok(mcp.sessions.length >= 3, 'the failing server was reconnected');
});

test('#1081: a failed remote server is not retried before its first backoff step has passed', async () => {
  const servers = [{ id: 'tavily', url: 'http://t/mcp', auth: 'none' }];
  const catalogues = { 'http://t/mcp': new Error('fetch failed') };
  const manifest = [{ id: 'web-search', server: 'tavily', tools: ['tavily_search'] }];
  const { wiring, mcp } = build({ servers, catalogues, manifest, discoveryTtlMs: 10 * 60 * 1000, discoveryRetryMs: [60000, 120000] });
  await wiring.discoverMcpTools();
  const afterFirst = mcp.sessions.length;
  await wiring.discoverMcpTools();
  assert.equal(mcp.sessions.length, afterFirst, 'inside the 60 s step an unforced request does not reconnect');
});

test('#1081: a healthy discovery keeps the whole TTL, so the short retry never applies to it', async () => {
  const servers = [{ id: 'nc', url: 'http://n/mcp', auth: 'none' }];
  const catalogues = { 'http://n/mcp': [rawTool('nc_list')] };
  const manifest = [{ id: 'nextcloud', server: 'nc', tools: ['nc_list'] }];
  const { wiring, mcp } = build({ servers, catalogues, manifest, discoveryTtlMs: 10 * 60 * 1000, discoveryRetryMs: [0] });
  await wiring.discoverMcpTools();
  const afterFirst = mcp.sessions.length;
  await wiring.discoverMcpTools();
  assert.equal(mcp.sessions.length, afterFirst, 'a healthy server is not re-discovered within the TTL');
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

test('discovery skips a personal/oauth credential once its adding administrator is disabled', async () => {
  const servers = [
    { id: 'p', url: 'http://p/mcp', auth: 'personal', title: 'Personal', addedBy: 'keyed' },
    { id: 'o', url: 'http://o/mcp', auth: 'oauth', title: 'OAuth', addedBy: 'signed' },
  ];
  const catalogues = { 'http://p/mcp': [rawTool('p_read')], 'http://o/mcp': [rawTool('o_read')] };
  const { wiring } = build({ servers, catalogues, isUserDisabled: (uid) => uid === 'keyed' || uid === 'signed' });
  const state = await wiring.discoverMcpTools();
  assert.equal(state.tools.size, 0);
  assert.match(state.servers.get('p').error, /active administrator/);
  assert.match(state.servers.get('o').error, /active administrator/);
});

test('discovery uses each mode\'s service credential: a bearer from the environment, a discovery-only capability token for the internal server', async () => {
  const servers = [
    { id: 'nc', url: 'http://nc/mcp', auth: 'nextcloud' },
    { id: 'b', url: 'http://b/mcp', auth: 'bearer', tokenEnv: 'B_TOKEN' },
    { id: 'i', url: 'http://127.0.0.1:9/mcp', auth: 'internal' },
  ];
  const catalogues = { 'http://nc/mcp': [rawTool('nc_read')], 'http://b/mcp': [rawTool('b_read')], 'http://127.0.0.1:9/mcp': [rawTool('i_write')] };
  const { wiring, mcp, minted } = build({ servers, catalogues, env: { B_TOKEN: 'secret' } });
  await wiring.discoverMcpTools();
  assert.equal(wiring.state.tools.size, 3);
  assert.deepEqual(mcp.sessions.find((s) => s.url === 'http://b/mcp').headers, { Authorization: 'Bearer secret' });
  assert.equal(mcp.sessions.find((s) => s.url === 'http://nc/mcp').headers, null, 'no account credential is attached to a listing');
  assert.ok(minted.some((c) => c.discovery === true && c.ttlMs === 120000));
  assert.ok(mcp.sessions.every((s) => !s.open), 'every discovery session is closed');
});

test('a call is the front\'s: the client sends the account, the offers and the approval, and returns the front\'s text', async () => {
  const servers = [
    { id: 'nc', url: 'http://nc/mcp', auth: 'nextcloud' },
    { id: 'i', url: 'http://127.0.0.1:9/mcp', auth: 'internal' },
  ];
  const catalogues = { 'http://nc/mcp': [rawTool('nc_read'), rawTool('shared')], 'http://127.0.0.1:9/mcp': [rawTool('i_write'), rawTool('shared')] };
  const asked = [];
  const { wiring, scope, minted } = build({ servers, catalogues, mcpExec: async (request, opts) => { asked.push([request, opts]); return { ok: true, text: `front:${request.name}` }; } });
  await wiring.discoverMcpTools();
  const controller = new AbortController();
  const out = await asUser(scope, 'alice', () => wiring.executeMcpToolCall('nc_read', { q: 1 }, controller.signal));
  assert.equal(out, 'front:nc_read');
  assert.deepEqual(asked[0][0], { name: 'nc_read', args: { q: 1 }, offers: ['nc'], caller: 'alice', workspace: 'alice' });
  assert.equal(asked[0][1].signal, controller.signal, 'a Stop reaches the front');
  // A name two servers offer goes with every offer (the front refuses the guess), and the token only because an internal server could take it.
  await asUser(scope, 'alice', () => wiring.executeMcpToolCall('shared', {}));
  assert.deepEqual(asked[1][0].offers, ['nc', 'i']);
  assert.equal(asked[1][0].internalAuth, 'Bearer cap');
  assert.equal(asked[0][0].internalAuth, undefined, 'no capability token for a call no internal server could take');
  // Internal: the capability token names the user, the project in scope and whether it is a write.
  await scope.run({ workspace: { userId: 'alice' }, authn: { user: { id: 'alice' } }, internalCallProject: { id: 'proj' }, internalEditTarget: 'f.md' }, () => wiring.executeMcpToolCall('i_write', {}, undefined, 'i'));
  assert.deepEqual(minted.at(-1), { uid: 'alice', pid: 'proj', w: 1, t: 'f.md' });
  assert.deepEqual(asked.at(-1)[0], { name: 'i_write', args: {}, offers: ['i'], server: 'i', caller: 'alice', workspace: 'alice', editTarget: true, internalAuth: 'Bearer cap' });
  // No account in scope: nothing about one is invented.
  await wiring.executeMcpToolCall('nc_read', {});
  assert.deepEqual(asked.at(-1)[0], { name: 'nc_read', args: {}, offers: ['nc'] });
});

test('a front that cannot be asked, or does not answer, refuses the call: it never runs it here', async () => {
  const servers = [{ id: 'b', url: 'http://b/mcp', auth: 'none' }];
  const unavailable = 'ERROR calling b_read: tool execution is unavailable right now. Try again in a moment.';
  for (const mcpExec of [
    async () => { throw Object.assign(new Error('The project store is busy.'), { code: 'PROJECTS_BUSY' }); },
    async () => ({ ok: false, status: 503 }),
    async () => ({ ok: false, status: 401 }),
    async () => undefined,
  ]) {
    const { wiring, mcp } = build({ servers, catalogues: { 'http://b/mcp': [rawTool('b_read')] }, mcpExec });
    await wiring.discoverMcpTools();
    const before = mcp.calls.length;
    assert.equal(await wiring.executeMcpToolCall('b_read', {}), unavailable);
    assert.equal(mcp.calls.length, before, 'the tool was not called from this process');
  }
  // The default, with nothing wired, is the same refusal.
  const bare = build({ servers, catalogues: { 'http://b/mcp': [rawTool('b_read')] } });
  await bare.wiring.discoverMcpTools();
  assert.equal(await bare.wiring.executeMcpToolCall('b_read', {}), unavailable);
  // A Stop is a stop, not an outage.
  const controller = new AbortController();
  const stopped = build({ servers, catalogues: { 'http://b/mcp': [rawTool('b_read')] }, mcpExec: async (_r, { signal }) => { controller.abort(); throw Object.assign(new Error('x'), { name: 'AbortError' }); } });
  await stopped.wiring.discoverMcpTools();
  assert.equal(await stopped.wiring.executeMcpToolCall('b_read', {}, controller.signal), 'ERROR calling b_read: This operation was aborted');
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

test('#2202: a sign-in or key the Rust front stored since the last discovery is noticed, without a forced discovery', async () => {
  let signedIn = false;
  const mcpOAuth = { connected: () => signedIn, tokenFor: async () => (signedIn ? 'admin-token' : null) };
  const servers = [{ id: 'o', url: 'http://o/mcp', auth: 'oauth', title: 'OAuth', addedBy: 'admin' }, { id: 'b', url: 'http://b/mcp', auth: 'bearer', tokenEnv: 'T' }];
  const { wiring, mcp } = build({ servers, mcpOAuth, env: { T: 't' }, manifest: [{ id: 'b-box', server: 'b' }], catalogues: { 'http://o/mcp': [rawTool('o_read')], 'http://b/mcp': [rawTool('b_read')] } });
  let state = await wiring.discoverMcpTools();
  assert.match(state.servers.get('o').error, /waiting for the administrator who added it to sign in/);
  assert.equal(state.tools.has('o_read'), false);
  // Cached while nothing moved.
  const before = mcp.sessions.length;
  await wiring.discoverMcpTools();
  assert.equal(mcp.sessions.length, before, 'no credential changed, so no new discovery');
  // The administrator signs in (the callback was the front's): the very next request reads the list.
  signedIn = true;
  state = await wiring.discoverMcpTools();
  assert.equal(state.tools.has('o_read'), true);
  assert.equal(state.servers.get('o').error, null);
  const after = mcp.sessions.length;
  await wiring.discoverMcpTools();
  assert.equal(mcp.sessions.length, after, 'and it is cached again');
  // A sign-out is noticed the same way: the box is no longer offered.
  signedIn = false;
  state = await wiring.discoverMcpTools();
  assert.equal(state.tools.has('o_read'), false);
});

// ── #2202 round 2: the directory is the Rust front's table, re-read ──────────────────────────────
test('a directory server the Rust front adds is discovered on the next use, and one it removes is dropped', async () => {
  const servers = [];
  const dir = { id: 'dir-x', url: 'https://x.example/mcp', auth: 'none', directory: true, title: 'X', addedBy: 'admin' };
  const { wiring, dirState } = build({ servers, catalogues: { 'https://x.example/mcp': [rawTool('x_tool', true)] } });
  assert.equal(wiring.enabled(), false);
  await wiring.discoverMcpTools();
  assert.deepEqual([...wiring.state.tools.keys()], []);
  // The front inserted a row: the signal moves, nothing else tells this process.
  dirState.servers = [dir]; dirState.version++;
  const state = await wiring.discoverMcpTools();
  assert.equal(wiring.enabled(), true);
  assert.deepEqual(servers.map((sv) => sv.id), ['dir-x']);
  assert.deepEqual([...state.tools.keys()], ['x_tool'], 'rediscovered without a forced discovery');
  assert.deepEqual(state.boxes.map((b) => b.id), ['dir-x']);
  // The front removed it.
  dirState.servers = []; dirState.version++;
  await wiring.discoverMcpTools();
  assert.deepEqual(servers, []);
  assert.deepEqual([...wiring.state.tools.keys()], []);
  assert.deepEqual(wiring.state.boxes, []);
});

test('a directory the table cannot give is no servers: the account is asked nothing of a removed server (the front refuses the call itself)', async () => {
  const dir = { id: 'dir-x', url: 'https://x.example/mcp', auth: 'oauth', directory: true, title: 'X', addedBy: 'admin' };
  const { wiring, mcp, dirState } = build({ servers: [], directoryServers: [dir], catalogues: { 'https://x.example/mcp': [rawTool('x_tool', true)] },
    mcpOAuth: { connected: () => true, session: async () => ({ accessToken: 't', generation: 'g' }), tokenFor: async () => 't' } });
  await wiring.discoverMcpTools();
  assert.ok(wiring.oauthServerIds().has('dir-x'));
  assert.equal(wiring.accountReady('u', 'dir-x'), true);
  // The table becomes unreadable (the re-reader answers nothing at all).
  dirState.servers = []; dirState.version = 'unreadable';
  assert.equal(wiring.oauthServerIds().has('dir-x'), false);
  assert.equal(wiring.accountReady('u', 'dir-x'), false);
  assert.equal(mcp.calls.length, 0, 'nothing was sent to a server the table no longer lists');
});

test('the hot paths look at the table at most once per interval; a discovery always looks', async () => {
  const dir = { id: 'dir-x', url: 'https://x.example/mcp', auth: 'oauth', directory: true, title: 'X', addedBy: 'admin' };
  const { wiring, dirState } = build({ servers: [], catalogues: { 'https://x.example/mcp': [] } });
  // build() runs with no throttle; make a throttled one over the same pieces.
  const throttled = createMcpWiring({
    servers: [], manifest: [], mcp: fakeMcp({}), bindBoxes: () => [], directoryCheckMs: 60000,
    directoryMcp: { signal: () => { dirState.looks += 1; return dirState.version; }, asServers: () => dirState.servers, boxFor: () => ({}), headersFor: () => ({}) },
    mcpOAuth: { connected: () => false }, directoryUrlAllowed: async () => true, credentialOriginAllowed: () => false,
    scope: new AsyncLocalStorage(), storageFor: () => ({}), isWriteTool: () => false, internal: {}, internalKey: 'k', reduceToolResult: (t) => ({ text: t }), logger: { log() {}, warn() {} },
  });
  assert.ok(wiring);
  dirState.looks = 0;
  for (let i = 0; i < 50; i++) { throttled.oauthServerIds(); throttled.accountReady('u', 'x'); }
  assert.ok(dirState.looks <= 1, `at most one look for 100 hot-path calls, saw ${dirState.looks}`);
  dirState.servers = [dir]; dirState.version++;
  await throttled.discoverMcpTools();
  assert.equal(throttled.servers.length, 1, 'a discovery looks now, whatever the interval says');
});

test('the probe and the admin routes\' pending keys are gone: this client only calls and lists (#2202 round 2)', () => {
  const { wiring } = build({ servers: [], catalogues: {} });
  assert.equal(wiring.probeMcpAuth, undefined);
  const code = require('node:fs').readFileSync(require('node:path').join(__dirname, 'mcp-wiring.cjs'), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  assert.doesNotMatch(code, /pendingHeaders|probeMcpAuth/);
});
