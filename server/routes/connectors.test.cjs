'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createConnectorRoutes } = require('./connectors.cjs');

const WRITES = new Set(['nc_notes_create', 'drive_create_file']);
const isWrite = (name) => WRITES.has(name);

function harness({ state, modes = {} } = {}) {
  const set = [];
  const policy = {
    mode: (_u, tool, write) => (modes[tool] ? modes[tool] : write ? 'ask' : 'allow'),
    set: (user, tools, mode) => { set.push({ user, tools, mode }); for (const t of tools) modes[t] = mode; },
  };
  const routes = createConnectorRoutes({
    accounts: { forUser: () => ({ drive: { state: () => ({ configured: false, state: 'not-configured' }) }, backup: null }) },
    driveTools: { names: new Set(['drive_create_file']), labels: { drive_create_file: 'Create file' } },
    policy, offsite: { status: () => null }, isWrite,
    json: (res, status, body) => { res.status = status; res.body = body; },
    readBody: async (req) => req.body,
    nextcloud: {
      state: () => state,
      boxes: () => [{ id: 'nextcloud-notes', label: 'Nextcloud Notes', toolCount: 2 }],
      tools: () => ['nc_notes_search', 'nc_notes_create'],
    },
  });
  return { routes, set, modes };
}
const run = async (routes, req, path) => { const res = {}; await routes(req, res, { path, authn: { user: { id: 'u1' } } }); return res; };

test('the account sees Nextcloud beside Drive, with its state, boxes and tools', async () => {
  const { routes } = harness({ state: { configured: true, state: 'connected', account: 'sam', baseUrl: 'https://cloud.example/', message: '' } });
  const res = await run(routes, { method: 'GET' }, '/api/connectors');
  const nc = res.body.connectors.find((c) => c.id === 'nextcloud');
  assert.equal(nc.state, 'connected');
  assert.equal(nc.account, 'sam');
  assert.deepEqual(nc.boxes.map((b) => b.id), ['nextcloud-notes']);
  assert.deepEqual(nc.tools.map((t) => [t.name, t.write, t.mode]), [['nc_notes_search', false, 'allow'], ['nc_notes_create', true, 'ask']]);
});

test('a disconnected or refused connection says so instead of offering a connect button', async () => {
  for (const state of [
    { configured: true, state: 'disconnected', message: 'Connect Nextcloud under Settings → Diary & storage; its tools then use that same connection.' },
    { configured: true, state: 'error', account: 'sam', baseUrl: 'https://elsewhere.example/', message: 'not on this server\'s allowed list' },
    { configured: false, state: 'not-configured', message: 'no Nextcloud MCP server configured' },
  ]) {
    const { routes } = harness({ state });
    const nc = (await run(routes, { method: 'GET' }, '/api/connectors')).body.connectors.find((c) => c.id === 'nextcloud');
    assert.equal(nc.state, state.state);
    assert.match(nc.message, /Diary|allowed list|configured/);
    assert.deepEqual(nc.boxes, state.configured ? [{ id: 'nextcloud-notes', label: 'Nextcloud Notes', toolCount: 2 }] : []);
  }
});

test('permissions change only tools this connector offers, and a write can never be allowed', async () => {
  const { routes, set } = harness({ state: { configured: true, state: 'connected', account: 'sam' } });
  const ok = await run(routes, { method: 'PUT', body: { tools: ['nc_notes_search', 'drive_create_file', 'made_up'], mode: 'block' } }, '/api/connectors/nextcloud/policy');
  assert.equal(ok.status, 200);
  assert.deepEqual(set[0].tools, ['nc_notes_search'], 'another connector’s tool is not touched');
  const blocked = ok.body.tools.find((t) => t.name === 'nc_notes_search');
  assert.equal(blocked.mode, 'block');
});

test('without a Nextcloud MCP server the connector is not offered at all', async () => {
  const routes = createConnectorRoutes({
    accounts: { forUser: () => ({ drive: { state: () => ({ configured: false, state: 'not-configured' }) }, backup: null }) },
    driveTools: { names: new Set(), labels: {} }, policy: { mode: () => 'allow', set: () => {} }, offsite: { status: () => null },
    isWrite, json: (res, status, body) => { res.status = status; res.body = body; }, readBody: async () => ({}),
  });
  const res = await run(routes, { method: 'GET' }, '/api/connectors');
  assert.deepEqual(res.body.connectors.map((c) => c.id), ['gdrive']);
  const denied = await run(routes, { method: 'PUT', body: {} }, '/api/connectors/nextcloud/policy');
  assert.equal(denied.status, 404);
});
