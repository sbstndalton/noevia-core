'use strict';
// #615 (round 9): the composer tools menu is fed by /api/toolboxes/permitted, which left out the
// `inApp` flag /api/toolboxes carried, so every MCP-backed in-app box stayed English. The flag now
// comes from one helper; this asserts that EVERY server path that hands toolboxes to the client
// carries it for EVERY in-app box, through the real route factory, so the paths cannot drift again.
const test = require('node:test');
const assert = require('node:assert/strict');
const { isInAppBox } = require('./toolbox-flags.cjs');
const { buildCatalogue } = require('./mcp-discovery-snapshot.cjs');
const { createToolboxRoutes } = require('./routes/toolboxes.cjs');
const { buildInAppBoxes } = require('./toolbox-inapp-fixture.cjs');

const fixture = buildInAppBoxes();
const IN_APP_IDS = fixture.allToolboxes().map((b) => b.id);

function makeRoutes() {
  return createToolboxRoutes({
    discoverMcpTools: async () => {}, toolboxSummaries: (c) => fixture.toolboxSummaries(c), connectedBoxes: () => ['gdrive'],
    prefill: { targetMs: 1, stats: () => ({}) }, mcp: () => ({ enabled: false, state: { error: null, tools: new Map(), servers: new Map() }, servers: [], manifest: [] }),
    json: (res, status, body) => { res.status = status; res.body = body; },
  });
}

/** What the Rust front is given of the offered boxes (the discovery snapshot's catalogue). */
function catalogueOf({ boxes = fixture.allToolboxes(), manifest = [] } = {}) {
  return buildCatalogue({
    allToolboxes: () => boxes, manifest, mcpEnabled: () => true, servers: [], state: { servers: new Map(), boxes: [] }, isWriteTool: () => false,
    harnessEnabled: () => true, hasRepositories: () => true, nextcloudOrigins: [], defaultToolboxes: ['core'], connectorBoxes: ['gdrive'],
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

// GET /api/toolboxes/permitted is the Rust front's (#2202 round 2), built from the catalogue this process publishes: the
// flag it flags the composer tools menu with is the one in that catalogue, from the same helper.
test('the published catalogue (the composer tools menu\'s source) flags every in-app box', () => {
  const c = catalogueOf();
  const byId = Object.fromEntries(c.boxes.map((b) => [b.id, b]));
  for (const id of IN_APP_IDS) assert.equal(byId[id].inApp, true, `catalogue ${id} (source ${byId[id].source})`);
  assert.equal(byId.diary.source, 'mcp', 'the shape that broke: an MCP-backed box');
});

test('a configured-but-undiscovered manifest box is still flagged in-app in the catalogue', () => {
  const manifest = [{ id: 'nextcloud-calendar', label: 'Calendar', description: 'Calendar' }];
  const c = catalogueOf({ boxes: [], manifest });
  assert.deepEqual(c.manifest, [{ id: 'nextcloud-calendar', label: 'Calendar', description: 'Calendar', inApp: true }]);
});

test('every path agrees with the one helper, and a third party box is never in-app on any path', () => {
  const foreign = { id: 'their-box', label: 'Theirs', description: 'x', source: 'mcp', tools: [{ type: 'function', function: { name: 'their_tool' } }] };
  const boxes = [...fixture.allToolboxes(), foreign];
  const c = catalogueOf({ boxes });
  assert.equal(c.boxes.find((b) => b.id === 'their-box').inApp, false);
  for (const b of boxes) assert.equal(c.boxes.find((x) => x.id === b.id).inApp, isInAppBox(b), b.id);
  assert.equal(isInAppBox(null), false);
});
