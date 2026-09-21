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
    servers, mcpState: { servers: new Map([['dir-a', { toolCount: 3, error: null }]]), tools: new Map() },
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
  assert.deepEqual(res.out.body, { servers: [{ id: 'dir-a', title: 'A', connected: false }] });
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
  assert.equal(r2.out.body.servers[0].redirectUri, 'https://noevia.example/api/mcp-oauth/callback');
  const r3 = fakeRes();
  await routes(req('DELETE'), r3, { path: '/api/admin/mcp-directory/dir-a', authn: admin });
  assert.equal(r3.out.code, 200);
  assert.deepEqual(calls.map((c) => c[0]), ['forget', 'remove', 'sync', 'discover']);
  const r4 = fakeRes();
  await routes(req('PATCH'), r4, { path: '/api/admin/mcp-directory', authn: admin });
  assert.equal(r4.out.code, 405);
});
