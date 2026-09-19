'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createPluginDirectoryRoutes, mcpItems } = require('./plugin-directory.cjs');

const reply = () => { const r = {}; return [r, (res, status, body) => { r.status = status; r.body = body; }]; };

test('maps both registry shapes and drops non-https links', () => {
  const items = mcpItems({ servers: [
    { server: { name: 'io.github.a/one', description: 'One', version: '1.0.0', repository: { url: 'https://github.com/a/one' }, remotes: [{}] } },
    { name: 'b/two', description: 'Two', repository: { url: 'javascript:alert(1)' } },
    { server: { name: 'io.github.a/one', version: '0.9.0' } },
  ] });
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], { id: 'io.github.a/one', name: 'one', publisher: 'io.github.a', description: 'One', version: '1.0.0', url: 'https://github.com/a/one', remote: true });
  assert.equal(items[1].url, '');
});

test('fetches only the fixed registry host, caches, and reports failures as 502', async () => {
  const urls = [];
  let ok = true;
  const routes = createPluginDirectoryRoutes({ json: undefined, fetchImpl: async (u) => { urls.push(u); return { ok, status: ok ? 200 : 500, json: async () => ({ servers: [] }) }; } });
  const [r, json] = reply();
  const run = createPluginDirectoryRoutes({ json, fetchImpl: async (u) => { urls.push(u); return { ok, status: ok ? 200 : 500, json: async () => ({ servers: [{ name: 'x/y' }] }) }; } });
  assert.equal(await run({ method: 'GET', url: '/api/plugins/directory?kind=mcp&q=git hub' }, {}, { path: '/api/plugins/directory' }), true);
  assert.equal(r.status, 200);
  assert.match(urls[0], /^https:\/\/registry\.modelcontextprotocol\.io\/v0\/servers\?limit=40&search=git%20hub$/);
  await run({ method: 'GET', url: '/api/plugins/directory?kind=mcp&q=git hub' }, {}, { path: '/api/plugins/directory' });
  assert.equal(urls.length, 1);
  ok = false;
  await run({ method: 'GET', url: '/api/plugins/directory?kind=mcp&q=other' }, {}, { path: '/api/plugins/directory' });
  assert.equal(r.status, 502);
  assert.equal(await routes({ method: 'GET' }, {}, { path: '/api/other' }), false);
});
