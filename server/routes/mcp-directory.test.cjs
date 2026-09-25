'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createMcpDirectoryRoutes } = require('./mcp-directory.cjs');

// The routes with everything behind them stubbed: no server, no network, no database.

function fakeRes() {
  const out = { code: null, body: null, headers: null };
  return { out, writeHead(code, headers) { out.code = code; out.headers = headers; }, end(text) { out.body = text ? JSON.parse(text) : null; } };
}
const json = (res, code, body) => { res.writeHead(code, {}); res.end(JSON.stringify(body)); };
const req = (method, body) => ({ method, url: '/x', body });
const readJson = async (r) => { if (r.body === undefined) throw new Error('no body'); return r.body; };

function build(overrides = {}) {
  const servers = [{ id: 'dir-a', url: 'https://a.example/mcp', auth: 'oauth', title: 'A', directory: true }];
  const calls = [];
  const deps = {
    json, readJson, auth: { origin: 'https://noevia.example', audit: () => {} },
    servers, mcpState: { servers: new Map([['dir-a', { toolCount: 3, error: null }]]), tools: new Map(), boxes: [{ id: 'dir-a', server: 'dir-a', directory: true, tools: [{ function: { name: 'find_note', description: 'Find a note', parameters: { secret: 'never expose' } } }] }] },
    directoryMcp: {
      list: () => [{ id: 'dir-a', title: 'A', url: 'https://a.example/mcp', oauth: true, personal: true, declaredHeaders: [{ name: 'X-Key', required: true, secret: true }] }],
      hasUserKey: (uid, id) => uid === 'u1' && id === 'dir-a',
      setUserKey: (...a) => calls.push(['setUserKey', ...a]),
      clearUserKey: (...a) => calls.push(['clearUserKey', ...a]),
      remove: (...a) => calls.push(['remove', ...a]),
      idFor: (x) => `dir-${x}`,
    },
    mcpOAuth: { connected: (uid) => uid === 'u1', clientInfo: () => null, disconnect: (...a) => calls.push(['disconnect', ...a]), forget: (...a) => calls.push(['forget', ...a]) },
    discoverOneServer: async () => new Map([['t', {}]]),
    discoverMcpTools: async () => calls.push(['discover']),
    probeMcpAuth: async () => ({ status: 0 }),
    syncDirectoryServers: () => calls.push(['sync']),
    directoryUrlAllowed: async () => true,
    ...overrides,
  };
  return { routes: createMcpDirectoryRoutes(deps), calls };
}
const member = { user: { id: 'u1', role: 'member' } };
const admin = { user: { id: 'adm', role: 'admin' } };

test('paths it does not own are left alone', async () => {
  const { routes } = build();
  assert.equal(await routes(req('GET'), fakeRes(), { path: '/api/projects', authn: member }), false);
});

test('a member sees the servers that want their own key, and whether they gave one', async () => {
  const { routes } = build();
  const res = fakeRes();
  assert.equal(await routes(req('GET'), res, { path: '/api/mcp-keys/servers', authn: member }), true);
  assert.deepEqual(res.out.body, { servers: [{ id: 'dir-a', title: 'A', headers: [{ name: 'X-Key', required: true, secret: true }], hasKey: true }] });
});

test('admin tool details are bounded to the server-bound toolbox', async () => {
  const offered = Array.from({ length: 45 }, (_, i) => ({ function: { name: `tool_${i}`, description: 'x'.repeat(300), parameters: { secret: 'hidden' } } }));
  const mcpState = { servers: new Map([['dir-a', { toolCount: 45, error: null }]]), boxes: [
    { id: 'other', server: 'other', directory: true, tools: [{ function: { name: 'wrong_server' } }] },
    { id: 'dir-a', server: 'dir-a', directory: true, tools: offered },
  ] };
  const { routes } = build({ mcpState });
  const res = fakeRes();
  await routes(req('GET'), res, { path: '/api/admin/mcp-directory', authn: admin });
  const row = res.out.body.servers[0];
  assert.equal(row.tools.length, 40);
  assert.equal(row.toolsTruncated, true);
  assert.equal(row.tools[0].description.length, 240);
  assert.equal(row.tools.some((tool) => tool.name === 'wrong_server'), false);
  assert.equal(JSON.stringify(row.tools).includes('hidden'), false);
});

test('custom preview validates and discovers bounded tools without saving', async () => {
  const discovered = new Map(Array.from({ length: 43 }, (_, i) => [`tool_${i}`, { tool: { function: { name: `tool_${i}`, description: 'd'.repeat(300), parameters: { secret: 'hidden' } } } }]));
  const { routes, calls } = build({ discoverOneServer: async () => discovered });
  const body = { title: 'Preview', url: 'https://external.example/mcp', headerName: 'X-Key', headerValue: 'secret', keyMode: 'personal' };
  const denied = fakeRes();
  await routes(req('POST', body), denied, { path: '/api/admin/mcp-directory/custom/preview', authn: member });
  assert.equal(denied.out.code, 403);
  const res = fakeRes();
  await routes(req('POST', body), res, { path: '/api/admin/mcp-directory/custom/preview', authn: admin });
  assert.equal(res.out.code, 200);
  assert.equal(res.out.body.toolCount, 43);
  assert.equal(res.out.body.tools.length, 40);
  assert.equal(res.out.body.tools[0].description.length, 240);
  assert.equal(res.out.body.toolsTruncated, true);
  assert.equal(JSON.stringify(res.out.body).includes('secret'), false);
  assert.deepEqual(calls, [], 'preview must not save, sync or start sign-in');
});

test('custom add requires matching preview and rolls back rediscovery drift', async () => {
  const calls = [];
  let variant = 'reviewed';
  const found = () => new Map([['search', { tool: { function: { name: 'search', description: variant, parameters: {} } } }]]);
  const mcpState = { servers: new Map(), boxes: [] };
  const directoryMcp = {
    list: () => [], idFor: () => 'dir-custom',
    add: () => { calls.push('add'); return { id: 'dir-custom', title: 'Custom', registryName: 'url:https://external.example/mcp' }; },
    remove: () => { calls.push('remove'); },
  };
  const { routes } = build({ directoryMcp, mcpState, discoverOneServer: async () => found(), syncDirectoryServers: () => calls.push('sync'),
    discoverMcpTools: async () => { calls.push('rediscover'); mcpState.boxes = [{ id: 'dir-custom', server: 'dir-custom', directory: true, tools: [{ function: { name: 'search', description: 'changed after save', parameters: {} } }] }]; } });
  const body = { title: 'Custom', url: 'https://external.example/mcp' };
  const preview = fakeRes();
  await routes(req('POST', body), preview, { path: '/api/admin/mcp-directory/custom/preview', authn: admin });
  const noToken = fakeRes();
  await routes(req('POST', body), noToken, { path: '/api/admin/mcp-directory/custom', authn: admin });
  assert.equal(noToken.out.code, 409);
  assert.deepEqual(calls, []);
  variant = 'changed before save';
  const changed = fakeRes();
  await routes(req('POST', { ...body, previewToken: preview.out.body.previewToken }), changed, { path: '/api/admin/mcp-directory/custom', authn: admin });
  assert.equal(changed.out.code, 409);
  assert.deepEqual(calls, []);
  variant = 'reviewed';
  const drift = fakeRes();
  await routes(req('POST', { ...body, previewToken: preview.out.body.previewToken }), drift, { path: '/api/admin/mcp-directory/custom', authn: admin });
  assert.equal(drift.out.code, 409);
  assert.deepEqual(calls, ['add', 'sync', 'rediscover', 'remove', 'sync', 'rediscover']);
});

test('custom add succeeds only with matching preview and stable rediscovery', async () => {
  const calls = [];
  const functionTool = { name: 'search', description: 'Find documents', parameters: {} };
  const mcpState = { servers: new Map(), boxes: [] };
  const row = { id: 'dir-custom', title: 'Custom', registryName: 'url:https://external.example/mcp' };
  const directoryMcp = { list: () => [row], idFor: () => row.id, add: () => { calls.push('add'); return row; }, remove: () => { calls.push('remove'); } };
  const { routes } = build({ directoryMcp, mcpState, discoverOneServer: async () => new Map([['search', { tool: { function: functionTool } }]]),
    syncDirectoryServers: () => calls.push('sync'), discoverMcpTools: async () => { calls.push('rediscover'); mcpState.boxes = [{ id: row.id, server: row.id, directory: true, tools: [{ function: functionTool }] }]; } });
  const body = { title: 'Custom', url: 'https://external.example/mcp' };
  const preview = fakeRes();
  await routes(req('POST', body), preview, { path: '/api/admin/mcp-directory/custom/preview', authn: admin });
  const changedForm = fakeRes();
  await routes(req('POST', { ...body, title: 'Renamed', previewToken: preview.out.body.previewToken }), changedForm, { path: '/api/admin/mcp-directory/custom', authn: admin });
  assert.equal(changedForm.out.code, 409);
  const added = fakeRes();
  await routes(req('POST', { ...body, previewToken: preview.out.body.previewToken }), added, { path: '/api/admin/mcp-directory/custom', authn: admin });
  assert.equal(added.out.code, 201);
  assert.deepEqual(calls, ['add', 'sync', 'rediscover']);
});

test('custom preview rejects invalid destination and header before discovery', async () => {
  let discovery = 0;
  const { routes, calls } = build({ discoverOneServer: async () => { discovery++; return new Map(); }, directoryUrlAllowed: async () => false });
  const privateAddress = fakeRes();
  await routes(req('POST', { title: 'Private', url: 'https://private.example/mcp' }), privateAddress, { path: '/api/admin/mcp-directory/custom/preview', authn: admin });
  assert.equal(privateAddress.out.code, 422);
  const invalidHeader = fakeRes();
  const publicRoutes = build({ discoverOneServer: async () => { discovery++; return new Map(); } }).routes;
  await publicRoutes(req('POST', { title: 'Header', url: 'https://external.example/mcp', headerName: 'Bad Header', headerValue: 'secret' }), invalidHeader, { path: '/api/admin/mcp-directory/custom/preview', authn: admin });
  assert.equal(invalidHeader.out.code, 400);
  assert.equal(discovery, 0);
  assert.deepEqual(calls, []);
});

test('custom preview reports sign-in requirement without adding a server', async () => {
  const { routes, calls } = build({ discoverOneServer: async () => { throw new Error('401'); }, probeMcpAuth: async () => ({ status: 401, challenge: 'test' }) });
  const res = fakeRes();
  await routes(req('POST', { title: 'OAuth', url: 'https://external.example/mcp' }), res, { path: '/api/admin/mcp-directory/custom/preview', authn: admin });
  assert.equal(res.out.body.requiresSignIn, true);
  assert.match(res.out.body.previewToken, /^\d{13}\.[0-9a-f]{64}$/);
  assert.deepEqual(res.out.body.tools, []);
  assert.deepEqual(calls, []);
});

test('a personal key is checked against the server before it is stored, and is this account\'s only', async () => {
  const { routes, calls } = build();
  const res = fakeRes();
  await routes(req('PUT', { headers: { 'X-Key': 'abc' } }), res, { path: '/api/mcp-keys/dir-a', authn: member });
  assert.equal(res.out.code, 200);
  assert.deepEqual(calls, [['setUserKey', 'u1', 'dir-a', { 'X-Key': 'abc' }]]);

  const rejected = build({ discoverOneServer: async () => { throw new Error('401'); } });
  const r2 = fakeRes();
  await rejected.routes(req('PUT', { headers: { 'X-Key': 'bad' } }), r2, { path: '/api/mcp-keys/dir-a', authn: member });
  assert.equal(r2.out.code, 422);
  assert.deepEqual(rejected.calls, [], 'a refused key is never stored');

  const r3 = fakeRes();
  await routes(req('PUT', { headers: {} }), r3, { path: '/api/mcp-keys/nope', authn: member });
  assert.equal(r3.out.code, 404);
});

test('sign-in servers list this account\'s own connection state', async () => {
  const { routes } = build();
  const res = fakeRes();
  await routes(req('GET'), res, { path: '/api/mcp-oauth/servers', authn: { user: { id: 'u2', role: 'member' } } });
  assert.deepEqual(res.out.body, { servers: [{ id: 'dir-a', title: 'A', connected: false, needsReauth: false }] });
});

test('the admin directory refuses members and answers admins', async () => {
  const { routes, calls } = build();
  const res = fakeRes();
  assert.equal(await routes(req('GET'), res, { path: '/api/admin/mcp-directory', authn: member }), true);
  assert.equal(res.out.code, 403);
  const r2 = fakeRes();
  await routes(req('GET'), r2, { path: '/api/admin/mcp-directory', authn: admin });
  assert.equal(r2.out.code, 200);
  assert.equal(r2.out.body.servers[0].toolCount, 3);
  assert.deepEqual(r2.out.body.servers[0].tools, [{ name: 'find_note', description: 'Find a note' }]);
  assert.equal(JSON.stringify(r2.out.body).includes('never expose'), false);
  assert.equal(r2.out.body.servers[0].redirectUri, 'https://noevia.example/api/mcp-oauth/callback');
  const r3 = fakeRes();
  await routes(req('DELETE'), r3, { path: '/api/admin/mcp-directory/dir-a', authn: admin });
  assert.equal(r3.out.code, 200);
  assert.deepEqual(calls.map((c) => c[0]), ['forget', 'remove', 'sync', 'discover']);
  const r4 = fakeRes();
  await routes(req('PATCH'), r4, { path: '/api/admin/mcp-directory', authn: admin });
  assert.equal(r4.out.code, 405);
});

// Review follow-ups for #258: the preview token expires, is bound to the admin who previewed,
// the sign-in path connects with its own token, and a concurrent delete still yields the 409.
const customDeps = (extra = {}) => {
  const calls = [];
  const functionTool = { name: 'search', description: 'Find documents', parameters: {} };
  const mcpState = { servers: new Map(), boxes: [] };
  const row = { id: 'dir-custom', title: 'Custom', registryName: 'url:https://external.example/mcp' };
  const directoryMcp = { list: () => [row], idFor: () => row.id, add: () => { calls.push('add'); return row; }, remove: () => { calls.push('remove'); } };
  const built = build({ directoryMcp, mcpState, discoverOneServer: async () => new Map([['search', { tool: { function: functionTool } }]]),
    syncDirectoryServers: () => calls.push('sync'), discoverMcpTools: async () => { calls.push('rediscover'); mcpState.boxes = [{ id: row.id, server: row.id, directory: true, tools: [{ function: functionTool }] }]; }, ...extra });
  return { ...built, calls, directoryMcp };
};
const customBody = { title: 'Custom', url: 'https://external.example/mcp' };

test('custom add refuses an expired preview token', async (t) => {
  const { routes, calls } = customDeps();
  const preview = fakeRes();
  await routes(req('POST', customBody), preview, { path: '/api/admin/mcp-directory/custom/preview', authn: admin });
  const realNow = Date.now;
  t.after(() => { Date.now = realNow; });
  Date.now = () => realNow() + 5 * 60 * 1000 + 1000;
  const late = fakeRes();
  await routes(req('POST', { ...customBody, previewToken: preview.out.body.previewToken }), late, { path: '/api/admin/mcp-directory/custom', authn: admin });
  assert.equal(late.out.code, 409);
  assert.deepEqual(calls, []);
});

test('a preview token is bound to the admin who previewed', async () => {
  const { routes, calls } = customDeps();
  const preview = fakeRes();
  await routes(req('POST', customBody), preview, { path: '/api/admin/mcp-directory/custom/preview', authn: admin });
  const other = fakeRes();
  await routes(req('POST', { ...customBody, previewToken: preview.out.body.previewToken }), other, { path: '/api/admin/mcp-directory/custom', authn: { user: { id: 'adm2', role: 'admin' } } });
  assert.equal(other.out.code, 409);
  assert.deepEqual(calls, []);
});

test('sign-in path connects with its own sign-in preview token', async () => {
  const calls = [];
  const row = { id: 'dir-oauth', title: 'OAuth', registryName: 'url:https://external.example/mcp' };
  const { routes } = build({
    discoverOneServer: async () => { throw new Error('401'); }, probeMcpAuth: async () => ({ status: 401, challenge: 'test' }),
    directoryMcp: { list: () => [row], idFor: () => row.id, add: (entry) => { calls.push(['add', entry.oauth]); return row; }, remove: () => calls.push('remove') },
    syncDirectoryServers: () => calls.push('sync'),
    mcpOAuth: { clientInfo: () => null, forget: () => {}, start: async () => { calls.push('start'); return 'https://auth.example/authorize'; } },
  });
  const body = { title: 'OAuth', url: 'https://external.example/mcp' };
  const preview = fakeRes();
  await routes(req('POST', body), preview, { path: '/api/admin/mcp-directory/custom/preview', authn: admin });
  const res = fakeRes();
  await routes(req('POST', { ...body, previewToken: preview.out.body.previewToken }), res, { path: '/api/admin/mcp-directory/custom', authn: admin });
  assert.equal(res.out.code, 202);
  assert.equal(res.out.body.signIn, 'https://auth.example/authorize');
  assert.deepEqual(calls, [['add', true], 'sync', 'start']);
});

test('a concurrent delete during rediscovery still returns the drift 409', async () => {
  const { routes, calls, directoryMcp } = customDeps({ discoverMcpTools: async () => { throw new Error('rediscovery failed'); } });
  directoryMcp.remove = () => { calls.push('remove'); throw Object.assign(new Error('not found'), { status: 404 }); };
  const preview = fakeRes();
  await routes(req('POST', customBody), preview, { path: '/api/admin/mcp-directory/custom/preview', authn: admin });
  const res = fakeRes();
  await routes(req('POST', { ...customBody, previewToken: preview.out.body.previewToken }), res, { path: '/api/admin/mcp-directory/custom', authn: admin });
  assert.equal(res.out.code, 409);
  assert.match(res.out.body.error, /not kept/);
  assert.ok(calls.includes('remove'));
});
