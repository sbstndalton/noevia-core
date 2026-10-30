'use strict';
// The catalogue Node publishes for the Rust front (sbstndalton/noevia#2202 round 2): what is in it, that it is written
// only while the front asks, atomically and privately, and that a slow discovery never holds the file back.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { buildCatalogue, createMcpDiscoveryPublisher, SNAPSHOT_FILE, SNAPSHOT_KIND } = require('./mcp-discovery-snapshot.cjs');
const { DEMAND_FILE } = require('./published-snapshot.cjs');

const fn = (name, description) => ({ type: 'function', function: { name, ...(description === undefined ? {} : { description }) } });
const tmp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-discovery-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

function input(over = {}) {
  const servers = [
    { id: 'nextcloud', url: 'http://nc/mcp', auth: 'nextcloud' },
    { id: 'dir-x', url: 'https://x.example.test/mcp', auth: 'oauth', directory: true, title: 'X' },
  ];
  const dirBox = { id: 'dir-x', server: 'dir-x', label: 'X', directory: true, description: 'Added from the MCP directory. Every call asks first.', source: 'mcp', tools: Array.from({ length: 45 }, (_, i) => fn(`t${i}`, 'd'.repeat(300))) };
  const boxes = [
    { id: 'core', label: 'Core', description: 'Built-ins', source: 'builtin', tools: [fn('get_current_time', 'Time'), { function: {} }, null, { function: { name: 7 } }, fn('read_project_file')] },
    { id: 'nextcloud-notes', server: 'nextcloud', label: 'Notes', description: 'Notes', source: 'mcp', tools: [fn('nc_notes_search_notes'), fn('nc_notes_create_note')] },
    dirBox,
  ];
  return {
    allToolboxes: () => boxes, manifest: [{ id: 'nextcloud-calendar', label: 'Calendar', description: 'Cal' }, { id: 'bare' }], mcpEnabled: () => true, servers,
    state: { servers: new Map([['dir-x', { error: null, toolCount: 45 }], ['nextcloud', { error: 'down', toolCount: 0 }]]), boxes },
    isWriteTool: (name) => name === 'nc_notes_create_note', harnessEnabled: () => true, hasRepositories: () => false,
    nextcloudOrigins: ['https://cloud.example.test'], defaultToolboxes: ['core'], connectorBoxes: ['gdrive'], ...over,
  };
}

test('the catalogue carries the offered boxes with their named tools, each tool\'s write flag and a 240-character description', () => {
  const c = buildCatalogue(input());
  assert.deepEqual(c.boxes.map((b) => b.id), ['core', 'nextcloud-notes', 'dir-x']);
  assert.deepEqual(c.boxes[0].tools, [{ name: 'get_current_time', description: 'Time', write: false }, { name: 'read_project_file', description: '', write: false }], 'an entry without a text name is not a tool');
  assert.deepEqual(c.boxes[1].tools.map((t) => [t.name, t.write]), [['nc_notes_search_notes', false], ['nc_notes_create_note', true]]);
  assert.equal(c.boxes[1].server, 'nextcloud');
  assert.equal(c.boxes[0].server, null);
  assert.equal(c.boxes[2].tools[0].description.length, 240);
  assert.equal(c.boxes[0].inApp, true);
  assert.equal(c.boxes[2].inApp, false, 'a box a third party defined is never in-app');
  assert.deepEqual([c.mcpEnabled, c.harnessEnabled, c.hasRepositories, c.nextcloudConfigured, c.nextcloudOrigins, c.defaults, c.connectorBoxes],
    [true, true, false, true, ['https://cloud.example.test'], ['core'], ['gdrive']]);
});

test('the configured boxes are published only while MCP is enabled, and the servers carry their last discovery', () => {
  const c = buildCatalogue(input());
  assert.deepEqual(c.manifest, [{ id: 'nextcloud-calendar', label: 'Calendar', description: 'Cal', inApp: true }, { id: 'bare', label: 'bare', description: '', inApp: true }]);
  const x = c.servers.find((s) => s.id === 'dir-x');
  assert.equal(x.toolCount, 45);
  assert.equal(x.tools.length, 40, 'the first 40 are shown');
  assert.equal(x.toolsTruncated, true);
  assert.equal(x.tools[0].description.length, 240);
  assert.deepEqual(c.servers.find((s) => s.id === 'nextcloud'), { id: 'nextcloud', auth: 'nextcloud', directory: false, error: 'down', toolCount: 0, tools: [], toolsTruncated: false });
  assert.deepEqual(buildCatalogue(input({ mcpEnabled: () => false })).manifest, []);
  const undiscovered = buildCatalogue(input({ state: { servers: new Map(), boxes: [] } })).servers.find((s) => s.id === 'dir-x');
  assert.deepEqual([undiscovered.toolCount, undiscovered.error, undiscovered.tools], [null, null, []], 'a server nobody has discovered yet');
});

test('nothing is written until the front asks; then the file is private, complete, of its kind and kept fresh; it stops when the asking does', async (t) => {
  const dir = tmp(t);
  let builds = 0;
  const publisher = createMcpDiscoveryPublisher({ dataDir: dir, discoverMcpTools: async () => {}, catalogue: () => { builds++; return buildCatalogue(input()); }, everyMs: 1000 });
  publisher.start();
  t.after(() => publisher.stop());
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(fs.existsSync(path.join(dir, SNAPSHOT_FILE)), false, 'no demand, no file, no work');
  assert.equal(builds, 0);
  // The front touches the demand marker.
  fs.writeFileSync(path.join(dir, DEMAND_FILE), String(Date.now()));
  publisher.demand.check();
  for (let i = 0; i < 50 && !fs.existsSync(path.join(dir, SNAPSHOT_FILE)); i++) await new Promise((r) => setTimeout(r, 40));
  const file = path.join(dir, SNAPSHOT_FILE);
  assert.ok(fs.existsSync(file), 'published once someone asks');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual([doc.version, doc.kind, doc.everyMs], [1, SNAPSHOT_KIND, 1000]);
  assert.ok(Math.abs(doc.writtenAt - Date.now()) < 5000);
  assert.equal(doc.boxes.length, 3);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], 'written atomically: no temporary file is left');
});

test('a slow discovery never holds the catalogue back: what is known is published, and a failing one costs nothing', async (t) => {
  const dir = tmp(t);
  let release;
  const slow = new Promise((r) => { release = r; });
  const publisher = createMcpDiscoveryPublisher({ dataDir: dir, discoverMcpTools: () => slow, catalogue: () => buildCatalogue(input()), everyMs: 1000, waitMs: 60 });
  t.after(() => { release(); });
  const started = Date.now();
  await publisher.publish();
  assert.ok(Date.now() - started < 1500, 'did not wait for the slow discovery');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, SNAPSHOT_FILE), 'utf8')).kind, SNAPSHOT_KIND);
  const failing = createMcpDiscoveryPublisher({ dataDir: tmp(t), discoverMcpTools: async () => { throw new Error('boom'); }, catalogue: () => buildCatalogue(input()), everyMs: 1000 });
  await failing.publish();
});

test('a catalogue that cannot be built writes nothing, so the file ages out and the front calls it not ready', async (t) => {
  const dir = tmp(t);
  const errors = [];
  const publisher = createMcpDiscoveryPublisher({ dataDir: dir, discoverMcpTools: async () => {}, catalogue: () => { throw new Error('no catalogue'); }, everyMs: 1000, onError: (e) => errors.push(e.message) });
  await publisher.publish();
  assert.equal(fs.existsSync(path.join(dir, SNAPSHOT_FILE)), false);
  assert.deepEqual(errors, ['no catalogue']);
});
