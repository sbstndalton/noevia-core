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
      remove: (...a) => calls.push(['remove', ...a]),
      idFor: (x) => `dir-${x}`,
    },
    mcpOAuth: { clientInfo: async () => null, forget: async (...a) => calls.push(['forget', ...a]) },
    mcpKeys: { set: async (...a) => calls.push(['keySet', ...a]) },
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

test('M3: a custom add rolled back because its tools changed also forgets the adding administrator\'s key', async () => {
  const calls = [];
  const { routes, directoryMcp } = customDeps({
    discoverMcpTools: async () => { throw new Error('rediscovery failed'); },
    mcpOAuth: { clientInfo: async () => null, forget: async (id) => { calls.push(['forget', id]); } },
    mcpKeys: { set: async (user, id, headers) => { calls.push(['keySet', user, id, Object.keys(headers)]); } },
  });
  const personal = { id: 'dir-custom', title: 'Custom', registryName: 'url:https://external.example/mcp', personal: true };
  directoryMcp.list = () => [personal];
  directoryMcp.add = () => { calls.push(['add']); return personal; };
  directoryMcp.remove = (id) => { calls.push(['remove', id]); };
  const body = { ...customBody, headerName: 'X-Api-Key', headerValue: 'synthetic-key', keyMode: 'personal' };
  const preview = fakeRes();
  await routes(req('POST', body), preview, { path: '/api/admin/mcp-directory/custom/preview', authn: admin });
  assert.equal(preview.out.code, 200, JSON.stringify(preview.out.body));
  const res = fakeRes();
  await routes(req('POST', { ...body, previewToken: preview.out.body.previewToken }), res, { path: '/api/admin/mcp-directory/custom', authn: admin });
  assert.equal(res.out.code, 409);
  assert.match(res.out.body.error, /not kept/);
  assert.deepEqual(calls, [['add'], ['keySet', 'adm', 'dir-custom', ['X-Api-Key']], ['remove', 'dir-custom'], ['forget', 'dir-custom']], 'the key the broker stored goes with the server');
  // A broker that cannot forget does not turn the 409 into something else (the start sweep removes it).
  const failing = customDeps({
    discoverMcpTools: async () => { throw new Error('rediscovery failed'); },
    mcpOAuth: { clientInfo: async () => null, forget: async () => { throw new Error('unavailable'); } },
    mcpKeys: { set: async () => {} },
  });
  failing.directoryMcp.list = () => [personal];
  failing.directoryMcp.add = () => personal;
  const p2 = fakeRes();
  await failing.routes(req('POST', body), p2, { path: '/api/admin/mcp-directory/custom/preview', authn: admin });
  const r2 = fakeRes();
  await failing.routes(req('POST', { ...body, previewToken: p2.out.body.previewToken }), r2, { path: '/api/admin/mcp-directory/custom', authn: admin });
  assert.equal(r2.out.code, 409);
});

test('L6: the admin list survives a broker that cannot describe one server\'s app', async () => {
  const { routes } = build({ mcpOAuth: { clientInfo: async () => { throw Object.assign(new Error('unavailable'), { status: 503 }); }, forget: async () => {} } });
  const res = fakeRes();
  await routes(req('GET'), res, { path: '/api/admin/mcp-directory', authn: admin });
  assert.equal(res.out.code, 200);
  assert.equal(res.out.body.servers[0].id, 'dir-a');
  assert.equal(res.out.body.servers[0].oauthClient, null);
  assert.equal(res.out.body.servers[0].redirectUri, 'https://noevia.example/api/mcp-oauth/callback');
});

test('#796: a body that is not a JSON object is a 400 on every admin directory write, not a TypeError', async () => {
  const { routes, calls } = build();
  for (const [method, path] of [['POST', '/api/admin/mcp-directory'], ['PUT', '/api/admin/mcp-directory/dir-a/keys'], ['POST', '/api/admin/mcp-directory/custom']]) {
    for (const body of [null, 7, []]) {
      const res = fakeRes();
      assert.equal(await routes(req(method, body), res, { path, authn: admin }), true, `${method} ${path}`);
      assert.deepEqual([res.out.code, res.out.body], [400, { error: 'invalid JSON' }], `${method} ${path} ${JSON.stringify(body)}`);
    }
  }
  assert.deepEqual(calls, [], 'nothing was added or changed');
});

// sbstndalton/noevia#2202: each account's own key and sign-in (and the sign-in callback) are the Rust
// front's; this module answers none of them, whatever the method, and index.cjs refuses them before
// authentication (rust-mcp-credentials.cjs).
test('the account routes the Rust front owns are not answered here', async () => {
  const { routes, calls } = build();
  for (const [method, path] of [['GET', '/api/mcp-keys/servers'], ['PUT', '/api/mcp-keys/dir-a'], ['DELETE', '/api/mcp-keys/dir-a'], ['GET', '/api/mcp-oauth/servers'],
    ['POST', '/api/mcp-oauth/dir-a/connect'], ['DELETE', '/api/mcp-oauth/dir-a'], ['GET', '/api/mcp-oauth/callback']]) {
    const res = fakeRes();
    assert.equal(await routes(req(method, {}), res, { path, authn: member }), false, `${method} ${path}`);
    assert.equal(res.out.code, null);
  }
  assert.deepEqual(calls, []);
});

test('describing a sign-in server asks the broker for its app, without its secret', async () => {
  const { routes } = build({ mcpOAuth: { clientInfo: async (id) => ({ manual: true, clientId: `id-of-${id}`, hasSecret: true, redirectUri: 'https://noevia.example/api/mcp-oauth/callback', issuer: 'https://as.example' }), forget: async () => {} } });
  const res = fakeRes();
  await routes(req('GET'), res, { path: '/api/admin/mcp-directory', authn: admin });
  assert.deepEqual(res.out.body.servers[0].oauthClient, { manual: true, clientId: 'id-of-dir-a', hasSecret: true, redirectUri: 'https://noevia.example/api/mcp-oauth/callback', issuer: 'https://as.example' });
});

test('removing a server asks the broker to forget it first, and a broker that cannot keeps the server', async () => {
  const { routes, calls } = build({ mcpOAuth: { clientInfo: async () => null, forget: async () => { throw Object.assign(new Error('MCP sign-ins and keys are unavailable right now. Try again in a moment.'), { status: 503 }); } } });
  const res = fakeRes();
  await routes(req('DELETE'), res, { path: '/api/admin/mcp-directory/dir-a', authn: admin });
  assert.equal(res.out.code, 503);
  assert.match(res.out.body.error, /unavailable right now/);
  assert.deepEqual(calls, [], 'nothing was removed, synced or rediscovered');
});

test('a personal server\'s adding administrator keeps the key they typed, through the broker', async () => {
  const calls = [];
  const row = { id: 'dir-custom', title: 'Custom', registryName: 'url:https://external.example/mcp', personal: true };
  const mcpState = { servers: new Map(), boxes: [] };
  const functionTool = { name: 'search', description: 'Find', parameters: {} };
  const make = (keySet) => build({
    directoryMcp: { list: () => [row], idFor: () => row.id, add: (entry) => { calls.push(['add', entry.personal]); return row; }, remove: () => calls.push('remove') },
    mcpState, mcpKeys: { set: keySet },
    mcpOAuth: { clientInfo: async () => null, forget: async (id) => { calls.push(['forget', id]); } },
    discoverOneServer: async () => new Map([['search', { tool: { function: functionTool } }]]),
    syncDirectoryServers: () => calls.push('sync'),
    discoverMcpTools: async () => { calls.push('rediscover'); mcpState.boxes = [{ id: row.id, server: row.id, directory: true, tools: [{ function: functionTool }] }]; },
  });
  const body = { title: 'Custom', url: 'https://external.example/mcp', headerName: 'X-Key', headerValue: 'admin-key', keyMode: 'personal' };
  const post = async (routes, extra = {}) => {
    const preview = fakeRes();
    await routes(req('POST', body), preview, { path: '/api/admin/mcp-directory/custom/preview', authn: admin });
    const res = fakeRes();
    await routes(req('POST', { ...body, previewToken: preview.out.body.previewToken, ...extra }), res, { path: '/api/admin/mcp-directory/custom', authn: admin });
    return res;
  };
  const ok = make(async (...a) => { calls.push(['keySet', ...a]); });
  const res = await post(ok.routes);
  assert.equal(res.out.code, 201);
  assert.deepEqual(calls.slice(0, 3), [['add', true], ['keySet', 'adm', 'dir-custom', { 'X-Key': 'admin-key' }], 'sync'], 'stored before the tool list is read with it');
  // A broker that cannot store it: no server is left that nobody can list tools of.
  calls.length = 0;
  const failing = make(async () => { throw Object.assign(new Error('unavailable'), { status: 503 }); });
  const bad = await post(failing.routes);
  assert.equal(bad.out.code, 503);
  assert.deepEqual(calls, [['add', true], 'remove', ['forget', 'dir-custom'], 'sync']);
});
