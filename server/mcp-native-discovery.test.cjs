'use strict';
// This process as a client of the Rust front's MCP discovery (mcp-native-discovery.cjs, mcp-wiring.cjs):
// what comes back becomes mcpState wholesale under a generation that never goes backwards, a front that
// cannot answer (or answers something else) leaves NOTHING offered, and the executor still routes by offers.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMcpWiring } = require('./mcp-wiring.cjs');
const { createNativeDiscovery, validate } = require('./mcp-native-discovery.cjs');

const fn = (name) => ({ type: 'function', function: { name, description: `${name} thing`, parameters: { type: 'object', properties: {}, required: [] } } });
const snap = (generation, over = {}) => ({
  version: 1, incarnation: "front-a", generation, enabled: true, error: null, discoveredAt: 1000, failedAt: 0, remoteFailStreak: 0,
  servers: [{ id: 'a', url: 'http://a/mcp', auth: 'none', error: null, discoveredAt: 1000, toolCount: 2 }, { id: 'b', url: 'http://b/mcp', auth: 'none', error: 'fetch failed', discoveredAt: 1000, toolCount: 0 }],
  offers: [{ name: 'one', server: 'a', readOnly: true, tool: fn('one') }, { name: 'dup', server: 'a', readOnly: null, tool: fn('dup') }, { name: 'dup', server: 'b', readOnly: false, tool: fn('dup') }],
  boxes: [{ id: 'box', server: 'a', label: 'Box', description: 'd', source: 'mcp', inApp: true, tools: [fn('one')], reads: ['one'] }],
  ...over,
});

function build(answers) {
  const asked = [];
  const broker = { mcpDiscovery: async (opts) => { asked.push(opts); const a = answers.shift(); if (a instanceof Error) throw a; return typeof a === 'function' ? a(opts) : a; } };
  const servers = [{ id: 'a', url: 'http://a/mcp', auth: 'none' }, { id: 'b', url: 'http://b/mcp', auth: 'none' }];
  const wiring = createMcpWiring({
    servers, mcp: {}, discovery: createNativeDiscovery({ broker }),
    directoryMcp: { signal: () => 0, asServers: () => [], headersFor: () => ({}) }, mcpOAuth: { connected: () => false }, mcpKeys: { hasKey: () => false },
    directoryUrlAllowed: async () => true, credentialOriginAllowed: () => false, scope: { getStore: () => undefined }, storageFor: () => ({}),
    isWriteTool: () => false, internal: {}, internalKey: 'k', reduceToolResult: (t) => ({ text: t }), env: {}, logger: { log() {}, warn() {} },
  });
  return { wiring, asked };
}

test('the snapshot becomes mcpState: first server wins a name, every offer is kept for routing', async () => {
  const { wiring } = build([snap(3)]);
  const state = await wiring.discoverMcpTools();
  assert.deepEqual([...state.tools].map(([n, e]) => [n, e.serverId]), [['one', 'a'], ['dup', 'a']]);
  assert.deepEqual([...state.offers.get('dup').keys()], ['a', 'b']);
  assert.equal(state.offers.get('dup').get('b').readOnly, false);
  assert.equal(state.offers.get('dup').get('a').readOnly, null);
  assert.deepEqual(state.boxes.map((b) => b.id), ['box']);
  assert.equal(state.servers.get('b').error, 'fetch failed');
  assert.equal(state.generation, 3);
  assert.equal(wiring.executeOperatorToolCall === undefined, false);
});

test('the held generation is sent, and "unchanged" keeps the state', async () => {
  const { wiring, asked } = build([snap(3), { unchanged: true, incarnation: "front-a", generation: 3 }]);
  await wiring.discoverMcpTools();
  const state = await wiring.discoverMcpTools();
  assert.deepEqual(asked.map((a) => [a.force, a.generation]), [[false, null], [false, 3]]);
  assert.equal(state.tools.size, 2);
});

test('an answer older than the state held is dropped', async () => {
  const { wiring } = build([snap(5), snap(4, { offers: [], boxes: [], servers: [] })]);
  await wiring.discoverMcpTools();
  const state = await wiring.discoverMcpTools();
  assert.equal(state.generation, 5);
  assert.equal(state.tools.size, 2);
});

test('fail closed: a front that cannot answer leaves no tool and no box, and the next call asks again', async () => {
  const down = Object.assign(new Error('busy'), { status: 503 });
  const { wiring } = build([snap(1), down, snap(2)]);
  await wiring.discoverMcpTools();
  assert.equal(wiring.state.tools.size, 2);
  const state = await wiring.discoverMcpTools();
  assert.equal(state.tools.size, 0);
  assert.deepEqual(state.boxes, []);
  assert.equal(state.servers.size, 0);
  assert.match(state.error, /unavailable/);
  assert.equal(state.generation, null);
  assert.equal(await wiring.executeMcpToolCall('one', {}), 'ERROR: unknown tool "one"', 'no call is routed on the strength of a list the front no longer stands behind');
  await wiring.discoverMcpTools();
  assert.equal(wiring.state.tools.size, 2);
});

test('fail closed: a reply of another shape never partly applies', async () => {
  for (const bad of [{}, snap(1, { offers: [{ name: 'x', server: 'nope', readOnly: null, tool: fn('x') }] }), snap(1, { offers: [{ name: 'x', server: 'a', readOnly: 'yes', tool: fn('x') }] }), snap(1, { offers: [{ name: 'x', server: 'a', readOnly: null, tool: fn('y') }] }), snap(1, { generation: -1 }), snap(1, { boxes: [{ id: 'b' }] })]) {
    assert.throws(() => validate(bad), /unexpected/);
    const { wiring } = build([snap(1), bad]);
    await wiring.discoverMcpTools();
    await wiring.discoverMcpTools();
    assert.equal(wiring.state.tools.size, 0, JSON.stringify(bad).slice(0, 60));
  }
});

test('a forced discovery is asked for when the directory table moved', async () => {
  let signal = 0;
  const asked = [];
  const wiring = createMcpWiring({
    servers: [], mcp: {}, discovery: { discover: async (o) => { asked.push(o.force); return snap(asked.length); } },
    directoryMcp: { signal: () => signal, asServers: () => [], headersFor: () => ({}) }, mcpOAuth: {}, mcpKeys: { hasKey: () => false },
    directoryUrlAllowed: async () => true, credentialOriginAllowed: () => false, scope: { getStore: () => undefined }, storageFor: () => ({}),
    isWriteTool: () => false, internal: {}, internalKey: 'k', reduceToolResult: (t) => ({ text: t }), env: {}, logger: { log() {}, warn() {} }, directoryCheckMs: 0,
  });
  await wiring.discoverMcpTools();
  signal = 1;
  await wiring.discoverMcpTools();
  assert.deepEqual(asked, [false, true]);
});

test('refreshSoon asks at most once at a time and not again within the pause', async () => {
  let release;
  const { wiring, asked } = build([() => new Promise((r) => { release = () => r(snap(1)); })]);
  wiring.refreshSoon(); wiring.refreshSoon();
  assert.equal(asked.length, 1);
  release();
  await new Promise((r) => setImmediate(r));
  wiring.refreshSoon();
  assert.equal(asked.length, 1, 'inside the pause');
});

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
test('late success after a newer failure cannot resurrect tools or reset the high-water mark', async () => {
  const late = deferred();
  const { wiring } = build([snap(5), () => late.promise, new Error('down'), snap(4)]);
  await wiring.discoverMcpTools();
  const pending = wiring.discoverMcpTools();
  await wiring.discoverMcpTools();
  late.resolve(snap(4)); await pending;
  assert.equal(wiring.state.tools.size, 0);
  await wiring.discoverMcpTools();
  assert.equal(wiring.state.tools.size, 0);
});
test('a front restart accepts generation zero and fences an old incarnation reply', async () => {
  const late = deferred();
  const { wiring } = build([snap(5), () => late.promise, snap(0, { incarnation: 'front-b' })]);
  await wiring.discoverMcpTools(); const pending = wiring.discoverMcpTools();
  await wiring.discoverMcpTools();
  assert.equal(wiring.state.generation, 0);
  late.resolve(snap(9)); await pending;
  assert.equal(wiring.state.incarnation, 'front-b');
  assert.equal(wiring.state.generation, 0);
});
for (const generation of [-1, 4, 6]) test(`unchanged generation ${generation} fails closed`, async () => {
  const { wiring } = build([snap(5), { unchanged: true, incarnation: 'front-a', generation }]);
  await wiring.discoverMcpTools(); await wiring.discoverMcpTools();
  assert.equal(wiring.state.tools.size, 0);
});
test('unchanged after concurrent invalidation cannot retain or resurrect state', async () => {
  const late = deferred();
  const { wiring } = build([snap(5), () => late.promise, new Error('down')]);
  await wiring.discoverMcpTools(); const pending = wiring.discoverMcpTools();
  await wiring.discoverMcpTools();
  late.resolve({ unchanged: true, incarnation: 'front-a', generation: 5 }); await pending;
  assert.equal(wiring.state.tools.size, 0);
});
test('unchanged for a different incarnation fails closed', async () => {
  const { wiring } = build([snap(5), { unchanged: true, incarnation: 'front-b', generation: 5 }]);
  await wiring.discoverMcpTools(); await wiring.discoverMcpTools();
  assert.equal(wiring.state.tools.size, 0);
});
