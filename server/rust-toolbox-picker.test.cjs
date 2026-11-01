'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createToolboxPickerFacts, PATH, MAX_BYTES } = require('./rust-toolbox-picker-facts.cjs');
const { refuseOwned, ROUTE_REFUSAL } = require('./rust-toolbox-picker.cjs');
const secret = 'synthetic-front-secret';
const credential = 'never-expose-synthetic-credential';
function fixture(over = {}) {
  const calls = [];
  let discovered = false;
  const handler = createToolboxPickerFacts({ secret,
    discoverMcpTools: async () => { discovered = true; },
    allToolboxes: () => { assert.ok(discovered); return [{ id: 'core', source: 'builtin', tools: [{ type: 'function', function: { name: 'get_time' } }], token: credential }]; },
    connectorBoxes: new Set(['gdrive']), prefill: { targetMs: 1250, stats: () => ({ model: { rate: 0.2 } }) },
    mcp: () => ({ enabled: true, state: { tools: new Map([['read', { serverId: 's', headers: { Authorization: credential } }]]), servers: new Map([['s', { error: null, toolCount: 1, discoveredAt: 42, accessToken: credential }]]) },
      servers: [{ id: 's', auth: 'oauth', directory: true, title: 'Synthetic', url: `https://user:${credential}@example.test/mcp?token=${credential}`, headers: { authorization: credential }, token: credential }],
      manifest: [{ server: 's', tools: ['read'], secret: credential }] }),
    json: (_r, status, body) => calls.push({ status, body }), readJson: async () => ({}), log: () => {}, ...over,
  });
  return { handler, calls };
}
const request = (over = {}) => ({ url: PATH, method: 'POST', socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-noevia-store-token': secret }, ...over });
test('raw facts wait for discovery and select only non-secret configuration fields', async () => {
  const { handler, calls } = fixture();
  assert.equal(await handler(request(), {}), true);
  assert.equal(calls[0].status, 200);
  const facts = calls[0].body;
  assert.deepEqual(facts.mcp.servers, [{ id: 's', auth: 'oauth', directory: true, title: 'Synthetic' }]);
  assert.deepEqual(facts.mcp.tools, [{ name: 'read', serverId: 's' }]);
  assert.deepEqual(facts.mcp.states, [{ id: 's', error: null, toolCount: 1, discoveredAt: 42 }]);
  assert.ok(!JSON.stringify(facts).includes(credential));
  assert.equal(facts.prefill.targetMs, 1250);
});
test('an auth credential payload is never forwarded as an authentication kind', async () => {
  for (const auth of [{ bearer: credential }, credential, `Bearer ${credential}`, `https://user:${credential}@example.test/?token=${credential}`]) {
    const f = fixture({ mcp: () => ({ enabled: true, servers: [{ id: 's', auth }] }) });
    await f.handler(request(), {});
    assert.equal(f.calls[0].status, 503);
    assert.ok(!JSON.stringify(f.calls).includes(credential));
  }
});
test('internal facts reject public/proxied peers, wrong secrets and methods before discovery', async () => {
  for (const req of [request({ socket: { remoteAddress: '10.0.0.2' } }), request({ headers: {} }), request({ headers: { 'x-noevia-store-token': 'wrong' } }), request({ headers: { 'x-noevia-store-token': secret, 'x-noevia-client-ip': '127.0.0.1' } }), request({ headers: { 'x-noevia-store-token': secret, 'x-forwarded-for': '127.0.0.1' } }), request({ method: 'GET' })]) {
    const { handler, calls } = fixture({ discoverMcpTools: () => assert.fail('discovery must not run') });
    assert.equal(await handler(req, {}), true); assert.equal(calls[0].status, 404);
  }
  const empty = fixture({ secret: '' }); await empty.handler(request(), {}); assert.equal(empty.calls[0].status, 404);
});
test('facts accept no account selector or other payload and fail closed on unavailable/oversize state', async () => {
  for (const body of [null, [], { userId: 'other' }, { connected: ['gdrive'] }]) {
    const f = fixture({ readJson: async () => body }); await f.handler(request(), {}); assert.equal(f.calls[0].status, 400);
  }
  for (const over of [{ discoverMcpTools: async () => { throw Error(credential); } }, { allToolboxes: () => [{ id: 'large', tools: ['x'.repeat(MAX_BYTES)] }] }]) {
    const f = fixture(over); await f.handler(request(), {}); assert.deepEqual(f.calls[0], { status: 503, body: { error: 'Toolbox facts are unavailable.' } });
  }
});
test('public Node path refuses every method before authentication and leaves siblings alone', () => {
  const calls = []; const options = { parseRequestUrl: req => new URL(req.url, 'http://localhost'), json: (_r, status, body) => calls.push({ status, body }) };
  for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH']) assert.equal(refuseOwned({ method, url: '/api/toolboxes?userId=other' }, {}, options), true);
  assert.ok(calls.every(c => c.status === 503 && c.body === ROUTE_REFUSAL));
  assert.equal(refuseOwned({ method: 'GET', url: '/api/toolboxes/permitted' }, {}, options), false);
});
