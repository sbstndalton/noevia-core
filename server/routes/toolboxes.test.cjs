'use strict';
// The route only assembles the picker's view; the boxes themselves are tested in
// toolboxes.test.cjs and the server summary in mcp-status.test.cjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createToolboxRoutes } = require('./toolboxes.cjs');

function fixture({ enabled = true } = {}) {
  const sent = [];
  let discoveries = 0;
  const routes = createToolboxRoutes({
    discoverMcpTools: async () => { discoveries += 1; },
    toolboxSummaries: () => [{ id: 'core', label: 'Core', toolCount: 2, estTokens: 200 }],
    prefill: { targetMs: 14000, stats: () => ({ 'm-9b': { rate: 0.36 } }) },
    mcp: () => ({
      enabled,
      state: { error: null, tools: new Map([['nc_notes_search_notes', { serverId: 'nextcloud', readOnly: true }]]), servers: new Map() },
      servers: [],
      manifest: [],
    }),
    json: (res, status, body) => { sent.push({ status, body }); return true; },
  });
  return { routes, sent, discoveries: () => discoveries };
}

test('the picker view waits for discovery and carries boxes, prefill and MCP state', async () => {
  const f = fixture();
  assert.equal(await f.routes({ method: 'GET' }, {}, { path: '/api/toolboxes', authn: { user: { id: 'u' } } }), true);
  assert.equal(f.discoveries(), 1, 'a cold start must not show only the built-in box');
  const { status, body } = f.sent[0];
  assert.equal(status, 200);
  assert.deepEqual(body.toolboxes.map((b) => b.id), ['core']);
  assert.equal(body.prefill.targetMs, 14000);
  assert.ok(body.prefill.models['m-9b']);
  assert.deepEqual(body.mcp, { configured: true, error: null, discovered: 1, servers: [] });
});

test('without MCP servers the picker says so instead of inventing an empty discovery', async () => {
  const f = fixture({ enabled: false });
  await f.routes({ method: 'GET' }, {}, { path: '/api/toolboxes', authn: { user: { id: 'u' } } });
  assert.deepEqual(f.sent[0].body.mcp, { configured: false });
});

test('other paths and methods are left alone or refused', async () => {
  const f = fixture();
  assert.equal(await f.routes({ method: 'GET' }, {}, { path: '/api/toolbox', authn: null }), false);
  assert.equal(await f.routes({ method: 'POST' }, {}, { path: '/api/toolboxes', authn: null }), true);
  assert.equal(f.sent[0].status, 405);
  assert.equal(f.discoveries(), 0);
});

// ── #237: GET /api/toolboxes/permitted ──
function permittedFixture() {
  const sent = [], calls = [];
  // Two tenants: each account sees only its own project, as the real getProject does.
  const projects = { 'u-a': { pa: { id: 'pa' } }, 'u-b': { pb: { id: 'pb' } } };
  const routes = createToolboxRoutes({
    discoverMcpTools: async () => {}, toolboxSummaries: () => [], prefill: { targetMs: 1, stats: () => ({}) },
    mcp: () => ({ enabled: false }), json: (res, status, body) => { sent.push({ status, body }); return true; },
    permitted: ({ authn, projectId, mode }) => {
      calls.push({ user: authn.user.id, projectId, mode });
      const project = projectId ? projects[authn.user.id][projectId] : null;
      if (projectId && !project) return null;
      return { project, boxes: [{ id: 'core', owner: authn.user.id, mode }] };
    },
  });
  const get = (user, query = '') => routes({ method: 'GET' }, {}, { path: '/api/toolboxes/permitted', authn: { user }, url: new URL(`http://x/api/toolboxes/permitted${query}`) });
  return { get, sent, calls };
}
const A = { id: 'u-a', role: 'member' }, B = { id: 'u-b', role: 'admin' };

test('permitted tools are computed per account and never served from another account\'s cache', async () => {
  const f = permittedFixture();
  await f.get(A, '?projectId=pa&mode=chat');
  await f.get(B, '?mode=chat');
  assert.equal(f.sent[0].body.boxes[0].owner, 'u-a');
  assert.equal(f.sent[1].body.boxes[0].owner, 'u-b');
  assert.equal(f.calls.length, 2);
});

test('another tenant\'s project is a 404, not an empty catalogue', async () => {
  const f = permittedFixture();
  await f.get(A, '?projectId=pb');
  assert.equal(f.sent[0].status, 404);
});

test('the view is cached per account/project/mode and a mode change recomputes', async () => {
  const f = permittedFixture();
  await f.get(A, '?projectId=pa&mode=chat');
  await f.get(A, '?projectId=pa&mode=chat');
  assert.equal(f.calls.length, 1, 'a repeat inside the TTL is served from cache');
  await f.get(A, '?projectId=pa&mode=cowork');
  assert.equal(f.calls.length, 2);
  assert.equal(f.sent[2].body.mode, 'cowork');
});

test('an unknown mode is refused', async () => {
  const f = permittedFixture();
  await f.get(A, '?mode=code');
  assert.equal(f.sent[0].status, 400);
});
