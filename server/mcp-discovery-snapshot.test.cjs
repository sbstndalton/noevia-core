'use strict';
// The catalogue Node publishes for the Rust front (sbstndalton/noevia#2202 round 2): what is in it, that it is written
// only while the front asks, atomically and privately, and that a slow discovery never holds the file back.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { buildCatalogue, createMcpDiscoveryPublisher, SNAPSHOT_FILE, SNAPSHOT_KIND, MAX_BYTES, MAX_BOX_TOOLS } = require('./mcp-discovery-snapshot.cjs');
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

// Review of round 2, H1: the front's JSON reader (serde_json) refuses a lone surrogate and the file may not pass 4 MiB;
// either made the snapshot Corrupt for everyone (/permitted 503, the Nextcloud connector, the policy PUT, admin counts).
const wellFormed = (value) => {
  if (typeof value === 'string') return value.isWellFormed();
  if (Array.isArray(value)) return value.every(wellFormed);
  if (value && typeof value === 'object') return Object.entries(value).every(([k, v]) => k.isWellFormed() && wellFormed(v));
  return true;
};
const LONE = /\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f][0-9a-f]{2})|(?<!\\ud[89ab][0-9a-f]{2})\\ud[c-f][0-9a-f]{2}/i;

test('a cut through a surrogate pair never leaves a lone surrogate in the file, in a name, a description, a label or an error', async (t) => {
  const emoji = '\u{1F600}';
  const at239 = `${'a'.repeat(239)}${emoji}tail`; // the pair straddles the 240-character cut
  const o = input();
  const box = { id: 'dir-x', server: 'dir-x', label: `${'L'.repeat(199)}${emoji}`, directory: true, description: `${'D'.repeat(999)}${emoji}`, source: 'mcp', tools: [fn(`${'n'.repeat(127)}${emoji}`, at239), fn('ok', at239)] };
  o.allToolboxes = () => [box];
  o.state = { servers: new Map([['dir-x', { error: `${'e'.repeat(999)}${emoji}`, toolCount: 2 }]]), boxes: [box] };
  o.manifest = [{ id: 'm', label: `${'m'.repeat(199)}${emoji}`, description: `${'x'.repeat(999)}${emoji}` }];
  const c = buildCatalogue(o);
  assert.ok(wellFormed(c), 'every string in the catalogue is well formed');
  assert.equal(c.boxes[0].tools[1].description, `${'a'.repeat(239)}�`, 'the stray half of the pair is replaced, not kept');
  assert.equal(c.servers.find((s) => s.id === 'dir-x').tools[1].description.length, 240);
  // The file itself, as written, holds no unpaired escape.
  const dir = tmp(t);
  const publisher = createMcpDiscoveryPublisher({ dataDir: dir, discoverMcpTools: async () => {}, catalogue: () => c, everyMs: 1000 });
  await publisher.publish();
  const text = fs.readFileSync(path.join(dir, SNAPSHOT_FILE), 'utf8');
  assert.doesNotMatch(text, LONE);
  assert.ok(wellFormed(JSON.parse(text)));
});

test('a server that lists twenty thousand tools cannot push the file past what the front reads', async (t) => {
  const emoji = '\u{1F600}';
  const huge = Array.from({ length: 20000 }, (_, i) => fn(`tool_${i}`, `${'a'.repeat(239)}${emoji}${'b'.repeat(300)}`));
  const box = { id: 'dir-x', server: 'dir-x', label: 'X', directory: true, description: 'd', source: 'mcp', tools: huge };
  const o = input();
  o.allToolboxes = () => [box];
  o.state = { servers: new Map([['dir-x', { error: null, toolCount: 20000 }]]), boxes: [box] };
  const c = buildCatalogue(o);
  assert.equal(c.boxes[0].tools.length, MAX_BOX_TOOLS, 'the box carries its first tools only');
  assert.equal(c.servers.find((s) => s.id === 'dir-x').toolCount, 20000, 'the count is still the real one');
  const dir = tmp(t);
  const publisher = createMcpDiscoveryPublisher({ dataDir: dir, discoverMcpTools: async () => {}, catalogue: () => c, everyMs: 1000 });
  await publisher.publish();
  const file = path.join(dir, SNAPSHOT_FILE);
  assert.ok(fs.statSync(file).size < 4 * 1024 * 1024, `${fs.statSync(file).size} bytes`);
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), LONE);
  // Many boxes, each within its own cap, together past the budget: cut harder, still readable.
  const boxes = Array.from({ length: 40 }, (_, k) => ({ ...box, id: `b${k}`, server: `b${k}`, tools: huge.slice(0, 600) }));
  const o2 = input();
  o2.allToolboxes = () => boxes;
  o2.servers = [];
  const c2 = buildCatalogue(o2);
  assert.ok(Buffer.byteLength(JSON.stringify(c2)) <= MAX_BYTES);
  assert.ok(c2.boxes.every((b) => b.tools.length > 0), 'every box keeps some tools');
});
