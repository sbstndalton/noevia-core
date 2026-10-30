'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createConnectorRoutes } = require('./connectors.cjs');
const { createDriveTools } = require('../gdrive-tools.cjs');
const { createToolboxes } = require('../toolboxes.cjs');

// GET /api/connectors and the Nextcloud permissions are what Node still answers (sbstndalton/noevia#2190
// round 7); the Google Drive writes are the Rust front's (noevia-rs tests/gdrive.rs) and refused here
// (rust-google-drive.test.cjs).
const WRITES = new Set(['nc_notes_create', 'drive_create_file']);
const isWrite = (name) => WRITES.has(name);
const DRIVE_VIEW = { id: 'gdrive', name: 'Google Drive', configured: true, state: 'disconnected', email: null, connectedAt: null, backup: null, tools: [] };

function harness({ state, modes = {}, onPolicyChange, setResult = { ok: true }, view = DRIVE_VIEW } = {}) {
  const set = [];
  const policy = { mode: (_u, tool, write) => (modes[tool] ? modes[tool] : write ? 'ask' : 'allow') };
  const toolPolicy = { set: async (user, tools, writes, mode) => { set.push({ user, tools, writes, mode }); if (setResult.ok) for (const t of tools) modes[t] = mode; return setResult; } };
  const asked = [];
  const routes = createConnectorRoutes({
    accounts: { view: async (user) => { asked.push(user.id); return view; } },
    policy, toolPolicy, isWrite, onPolicyChange,
    json: (res, status, body) => { res.status = status; res.body = body; },
    readBody: async (req) => req.body,
    nextcloud: {
      state: () => state,
      boxes: () => [{ id: 'nextcloud-notes', label: 'Nextcloud Notes', toolCount: 2 }],
      tools: () => ['nc_notes_search', 'nc_notes_create'],
    },
  });
  return { routes, set, modes, asked };
}
const run = async (routes, req, path) => { const res = {}; await routes(req, res, { path, authn: { user: { id: 'u1' } } }); return res; };

test('the account sees Nextcloud beside Drive (which the front answers), with its state, boxes and tools', async () => {
  const { routes, asked } = harness({ state: { configured: true, state: 'connected', account: 'sam', baseUrl: 'https://cloud.example/', message: '' } });
  const res = await run(routes, { method: 'GET' }, '/api/connectors');
  assert.deepEqual(res.body.connectors.map((c) => c.id), ['gdrive', 'nextcloud']);
  assert.deepEqual(asked, ['u1'], 'the Drive half comes from the broker for this account');
  const nc = res.body.connectors.find((c) => c.id === 'nextcloud');
  assert.equal(nc.state, 'connected');
  assert.equal(nc.account, 'sam');
  assert.deepEqual(nc.boxes.map((b) => b.id), ['nextcloud-notes']);
  assert.deepEqual(nc.tools.map((t) => [t.name, t.write, t.mode]), [['nc_notes_search', false, 'allow'], ['nc_notes_create', true, 'ask']]);
  assert.equal((await run(routes, { method: 'POST' }, '/api/connectors')).status, 405);
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

test('permissions change only tools this connector offers, and are written by the front with the write flags', async () => {
  const { routes, set } = harness({ state: { configured: true, state: 'connected', account: 'sam' } });
  const ok = await run(routes, { method: 'PUT', body: { tools: ['nc_notes_search', 'drive_create_file', 'made_up'], mode: 'block' } }, '/api/connectors/nextcloud/policy');
  assert.equal(ok.status, 200);
  assert.deepEqual(set, [{ user: 'u1', tools: ['nc_notes_search'], writes: [false], mode: 'block' }], 'another connector’s tool is not touched');
  assert.equal(ok.body.tools.find((t) => t.name === 'nc_notes_search').mode, 'block');
  const w = await run(routes, { method: 'PUT', body: { tools: ['nc_notes_search', 'nc_notes_create'], mode: 'ask' } }, '/api/connectors/nextcloud/policy');
  assert.equal(w.status, 200);
  assert.deepEqual(set.at(-1).writes, [false, true], 'the live classifier decides which tools write; the front enforces "a write never allows"');
});

test('the front\'s refusal reaches the page in core\'s words; an unreachable front is refused with its own status, never a silent success', async () => {
  let cleared = 0;
  const refused = harness({ state: { configured: true, state: 'connected' }, onPolicyChange: () => { cleared += 1; }, setResult: { ok: false, status: 400, error: 'Writes always ask first, so they cannot be set to Always allow.' } });
  const r = await run(refused.routes, { method: 'PUT', body: { tools: ['nc_notes_create'], mode: 'allow' } }, '/api/connectors/nextcloud/policy');
  assert.deepEqual([r.status, r.body], [400, { error: 'Writes always ask first, so they cannot be set to Always allow.' }]);
  assert.equal(cleared, 0, 'a refused save changed nothing, so nothing is cleared');
  const down = harness({ state: { configured: true, state: 'connected' }, setResult: { ok: false, status: 503 } });
  const d = await run(down.routes, { method: 'PUT', body: { tools: ['nc_notes_search'], mode: 'block' } }, '/api/connectors/nextcloud/policy');
  assert.equal(d.status, 503);
  assert.match(d.body.error, /could not be saved/);
  const ok = harness({ state: { configured: true, state: 'connected' }, onPolicyChange: () => { cleared += 1; } });
  await run(ok.routes, { method: 'PUT', body: { tools: ['nc_notes_search'], mode: 'block' } }, '/api/connectors/nextcloud/policy');
  assert.equal(cleared, 1, '#796: a saved permission clears the cached permitted-tools view');
});

test('the Google Drive paths are not Node\'s any more: its writes are the front\'s and refused earlier, anything else is a 404', async () => {
  const { routes, set } = harness({ state: { configured: true, state: 'connected' } });
  for (const [method, p] of [['POST', '/api/connectors/gdrive/connect'], ['PUT', '/api/connectors/gdrive/policy'], ['GET', '/api/connectors/gdrive/connect'], ['POST', '/api/connectors/other']]) {
    const res = await run(routes, { method, body: { tools: ['drive_create_file'], mode: 'block' } }, p);
    assert.equal(res.status, 404, `${method} ${p}`);
  }
  assert.deepEqual(set, [], 'nothing was written');
  assert.equal(await routes({ method: 'GET' }, {}, { path: '/api/other', authn: { user: { id: 'u1' } } }), false);
  const res = {};
  await routes({ method: 'GET' }, res, { path: '/api/connectors', authn: null });
  assert.equal(res.status, 401);
});

test('without a Nextcloud MCP server the connector is not offered at all', async () => {
  const routes = createConnectorRoutes({
    accounts: { view: async () => DRIVE_VIEW }, policy: { mode: () => 'allow' }, toolPolicy: { set: async () => ({ ok: true }) },
    isWrite, json: (res, status, body) => { res.status = status; res.body = body; }, readBody: async () => ({}),
  });
  const res = await run(routes, { method: 'GET' }, '/api/connectors');
  assert.deepEqual(res.body.connectors.map((c) => c.id), ['gdrive']);
  const denied = await run(routes, { method: 'PUT', body: {} }, '/api/connectors/nextcloud/policy');
  assert.equal(denied.status, 404);
});

test('the Drive tools are four reads and three writes with the real classifier, in the order and words the front lists', () => {
  const accounts = { forUser: () => ({ drive: { state: () => ({ state: 'connected' }) }, backup: null }) };
  const driveTools = createDriveTools({ accounts });
  const toolbox = createToolboxes({ boxes: [driveTools.box], driveTools, offered: (id) => id !== 'gdrive' });
  const listed = [...driveTools.names].map((name) => ({ name, label: driveTools.labels[name], write: toolbox.isWriteTool(name) }));
  // noevia-rs connector_routes.rs TOOLS and is_write are tested against this same file.
  const shared = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'gdrive-tools-list.v1.json'), 'utf8'));
  assert.deepEqual(listed, shared.tools);
  assert.deepEqual(listed.filter((t) => !t.write).map((t) => t.name), ['drive_search_files', 'drive_read_file', 'drive_get_metadata', 'drive_list_recent']);
  assert.deepEqual(listed.filter((t) => t.write).map((t) => t.name), ['drive_create_file', 'drive_update_file', 'drive_trash_file']);
});
