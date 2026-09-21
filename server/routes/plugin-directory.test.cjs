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
  assert.deepEqual(items[0], { id: 'io.github.a/one', name: 'one', publisher: 'io.github.a', description: 'One', version: '1.0.0', url: 'https://github.com/a/one', remote: true, installable: false, notInstallable: 'Uses a connection type noevia does not support' });
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

test('a published skill is fetched from the fixed raw host only, by a validated name, within 32 KiB', async () => {
  const { fetchPublishedSkill } = require('./plugin-directory.cjs');
  const urls = [];
  const ok = (text, status = 200) => async (u) => { urls.push(u); return { ok: status < 300, status, text: async () => text }; };
  assert.equal(await fetchPublishedSkill('frontend-design', { fetchImpl: ok('---\nname: x\n---') }), '---\nname: x\n---');
  assert.equal(urls[0], 'https://raw.githubusercontent.com/anthropics/skills/main/skills/frontend-design/SKILL.md');
  for (const bad of ['../etc', 'a/b', '', 'X'.repeat(3), 'a b']) await assert.rejects(fetchPublishedSkill(bad, { fetchImpl: ok('') }), /Unknown skill/);
  await assert.rejects(fetchPublishedSkill('big', { fetchImpl: ok('x'.repeat(40000)) }), /32 KiB/);
  await assert.rejects(fetchPublishedSkill('gone', { fetchImpl: ok('', 404) }), /no SKILL.md/);
  assert.equal(urls.length, 3, 'invalid names never reach the network');
});

test('starters resolve against the live directory, keep their order and line, and drop what vanished', async () => {
  const starters = require('../plugin-starters.json');
  const [r, json] = reply();
  const run = createPluginDirectoryRoutes({ json, fetchImpl: async (u) => {
    if (u.includes('api.github.com')) return { ok: true, json: async () => starters.skills.slice(1).map((s) => ({ type: 'dir', name: s.id, html_url: `https://github.com/anthropics/skills/tree/main/skills/${s.id}` })) };
    const name = decodeURIComponent(new URL(u).searchParams.get('search'));
    return { ok: true, json: async () => ({ servers: name === starters.mcp[0].id ? [] : [{ server: { name, remotes: [{ type: 'streamable-http', url: 'https://mcp.example.com/mcp' }] } }] }) };
  } });
  await run({ method: 'GET', url: '/api/plugins/directory?kind=skills&starters=1' }, {}, { path: '/api/plugins/directory' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.items.map((i) => i.id), starters.skills.slice(1).map((s) => s.id), 'a skill missing upstream is dropped');
  assert.equal(r.body.items[0].why, starters.skills[1].why);
  await run({ method: 'GET', url: '/api/plugins/directory?kind=mcp&starters=1' }, {}, { path: '/api/plugins/directory' });
  assert.deepEqual(r.body.items.map((i) => i.id), starters.mcp.slice(1).map((s) => s.id));
  assert.ok(r.body.items.every((i) => i.why && i.installable));
});
