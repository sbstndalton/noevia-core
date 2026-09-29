'use strict';
// #615 (round 9): the composer tools menu is fed by /api/toolboxes/permitted, which left out the
// `inApp` flag /api/toolboxes carried, so every MCP-backed in-app box stayed English. The flag now
// comes from one helper; this asserts that EVERY server path that hands toolboxes to the client
// carries it for EVERY in-app box, through the real route factory, so the paths cannot drift again.
const test = require('node:test');
const assert = require('node:assert/strict');
const { isInAppBox } = require('./toolbox-flags.cjs');
const { computePermittedTools } = require('./toolboxes-permitted.cjs');
const { createToolboxRoutes } = require('./routes/toolboxes.cjs');
const { buildInAppBoxes } = require('./toolbox-inapp-fixture.cjs');

const fixture = buildInAppBoxes();
const IN_APP_IDS = fixture.allToolboxes().map((b) => b.id);

function makeRoutes({ mode = 'chat', boxes = fixture.allToolboxes(), manifest = [] } = {}) {
  return createToolboxRoutes({
    discoverMcpTools: async () => {}, toolboxSummaries: (c) => fixture.toolboxSummaries(c), connectedBoxes: () => ['gdrive'],
    prefill: { targetMs: 1, stats: () => ({}) }, mcp: () => ({ enabled: false, state: { error: null, tools: new Map(), servers: new Map() }, servers: [], manifest: [] }),
    json: (res, status, body) => { res.status = status; res.body = body; },
    permitted: ({ authn }) => ({ project: null, boxes: computePermittedTools({
      user: authn.user, project: null, mode, boxes, manifest, defaultToolboxes: ['core'], connectorBoxes: new Set(['gdrive']), connected: ['gdrive'],
      oauthServerIds: new Set(), accountReady: () => true, policyMode: () => 'allow', isWriteTool: () => false,
      diaryEnabled: true, harnessEnabled: true, repositories: ['demo'],
    }) }),
  });
}

const authn = { user: { id: 'synthetic-user', role: 'admin' } };
async function get(routes, path) {
  const res = {};
  const handled = await routes({ method: 'GET' }, res, { path: path.split('?')[0], authn, url: new URL('http://x' + path) });
  assert.equal(handled, true);
  return res;
}

test('the fixture covers the real manifest: diary, project docs, web, Nextcloud, plus the built-ins', () => {
  for (const id of ['core', 'diary', 'project-docs', 'web-search', 'web-crawl', 'nextcloud-files', 'nextcloud-sharing', 'offline-wikipedia', 'gdrive']) assert.ok(IN_APP_IDS.includes(id), id);
});

test('GET /api/toolboxes (the model popup and picker) flags every in-app box', async () => {
  const res = await get(makeRoutes(), '/api/toolboxes');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.toolboxes.map((b) => b.id).sort(), [...IN_APP_IDS].sort());
  for (const b of res.body.toolboxes) assert.equal(b.inApp, true, `/api/toolboxes ${b.id}`);
});

test('GET /api/toolboxes/permitted (the composer tools menu) flags every in-app box, in both modes, and the coding harness', async () => {
  for (const mode of ['chat', 'cowork']) {
    const res = await get(makeRoutes({ mode }), `/api/toolboxes/permitted?mode=${mode}`);
    assert.equal(res.status, 200);
    const byId = Object.fromEntries(res.body.boxes.map((b) => [b.id, b]));
    for (const id of IN_APP_IDS) assert.equal(byId[id].inApp, true, `${mode}: /permitted ${id} (source ${byId[id].source})`);
    assert.equal(byId.code.inApp, true, 'the coding harness ships with noevia');
    assert.equal(byId.diary.source, 'mcp', 'the shape that broke: an MCP-backed box');
  }
});

test('a configured-but-undiscovered manifest box is still flagged in-app', async () => {
  const manifest = [{ id: 'nextcloud-calendar', label: 'Calendar', description: 'Calendar' }];
  const res = await get(makeRoutes({ boxes: [], manifest }), '/api/toolboxes/permitted?mode=chat');
  const row = res.body.boxes.find((b) => b.id === 'nextcloud-calendar');
  assert.equal(row.state, 'unavailable');
  assert.equal(row.inApp, true);
  assert.equal(row.reasonCode, 'notConnected');
});

test('every path agrees with the one helper, and a third party box is never in-app on any path', async () => {
  const foreign = { id: 'their-box', label: 'Theirs', description: 'x', source: 'mcp', tools: [{ type: 'function', function: { name: 'their_tool' } }] };
  const boxes = [...fixture.allToolboxes(), foreign];
  const res = await get(makeRoutes({ boxes }), '/api/toolboxes/permitted?mode=chat');
  assert.equal(res.body.boxes.find((b) => b.id === 'their-box').inApp, false);
  for (const b of boxes) assert.equal(res.body.boxes.find((x) => x.id === b.id).inApp, isInAppBox(b), b.id);
  assert.equal(isInAppBox(null), false);
});

test('reasons carry a code the client can word from its catalogue, with the English text as fallback', () => {
  const rows = computePermittedTools({
    user: { id: 'u', role: 'member' }, project: null, mode: 'chat', boxes: [], manifest: [], defaultToolboxes: [], connectorBoxes: new Set(), connected: [],
    oauthServerIds: new Set(), accountReady: () => true, policyMode: () => 'allow', isWriteTool: () => false, diaryEnabled: true, harnessEnabled: true, repositories: [],
  });
  const code = rows.find((b) => b.id === 'code');
  assert.equal(code.reasonCode, 'codeNeedsCowork');
  assert.match(code.reason, /Cowork/);
  for (const tool of code.tools) assert.equal(tool.reasonCode, 'codeNeedsCowork');
});
