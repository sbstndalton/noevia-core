'use strict';
const test = require('node:test');
const assert = require('node:assert');
// GET /api/plugins/directory is the Rust front's (#2190; its listing, cache and starters are tested
// there). These cover the mapping and lookups the Node-owned MCP directory and project skill routes use.
const { mcpItems, fallbackServerName, findRegistryServer } = require('./plugin-directory.cjs');

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

test('#410: two starters that both end in the generic slug "mcp" get distinct, readable titles', () => {
  const items = mcpItems({ servers: [
    { server: { name: 'com.notion/mcp', description: 'Notion', version: '1.0.0' } },
    { server: { name: 'com.cloudflare.mcp/mcp', description: 'Cloudflare docs', version: '1.0.0' } },
  ] });
  assert.equal(items.length, 2);
  assert.equal(items[0].id, 'com.notion/mcp');
  assert.equal(items[0].name, 'Notion');
  assert.equal(items[1].id, 'com.cloudflare.mcp/mcp');
  assert.equal(items[1].name, 'Cloudflare');
  assert.notEqual(items[0].name, items[1].name, 'never the same generic title for two different servers');
  assert.notEqual(items[0].name.toLowerCase(), 'mcp');
  assert.notEqual(items[1].name.toLowerCase(), 'mcp');
});

test('fallbackServerName: title wins, then a non-generic slug, then the namespace, then the host, never the literal "mcp"', () => {
  // A manifest title always wins, even over a perfectly fine slug.
  assert.equal(fallbackServerName({ name: 'co.huggingface/hf-mcp-server', title: 'Hugging Face' }), 'Hugging Face');
  // A non-generic trailing slug is used as-is (existing, working shapes).
  assert.equal(fallbackServerName({ name: 'ai.exa/exa' }), 'exa');
  assert.equal(fallbackServerName({ name: 'app.linear/linear' }), 'linear');
  // The generic slug "mcp" falls back to the last meaningful namespace segment.
  assert.equal(fallbackServerName({ name: 'com.notion/mcp' }), 'Notion');
  assert.equal(fallbackServerName({ name: 'com.cloudflare.mcp/mcp' }), 'Cloudflare');
  // No usable namespace segment (only generic words): fall back to the repository/website host.
  assert.equal(fallbackServerName({ name: 'mcp', repository: { url: 'https://github.com/acme/widget' } }), 'Github');
  assert.equal(fallbackServerName({ name: 'com.mcp/mcp', websiteUrl: 'https://widgetco.example.com' }), 'Widgetco');
  // Nothing at all to derive from: show the raw id rather than crash.
  assert.equal(fallbackServerName({ name: 'mcp' }), 'mcp');
});

test('the registry lookup reads only the fixed registry host and finds the exact name', async () => {
  const urls = [];
  const fetchImpl = async (u) => { urls.push(u); return { ok: true, status: 200, json: async () => ({ servers: [{ server: { name: 'x/yz' } }, { server: { name: 'x/y' } }] }) }; };
  const prior = process.env.NOEVIA_QA_MCP_REGISTRY;
  delete process.env.NOEVIA_QA_MCP_REGISTRY;
  try {
    assert.equal((await findRegistryServer('x/y', { fetchImpl })).id, 'x/y');
    assert.equal(urls[0], 'https://registry.modelcontextprotocol.io/v0/servers?limit=40&search=x%2Fy');
    assert.equal(await findRegistryServer('', { fetchImpl }), null);
    assert.equal(urls.length, 1);
    await assert.rejects(findRegistryServer('x/y', { fetchImpl: async () => ({ ok: false, status: 500 }) }), (e) => e.status === 502);
  } finally { if (prior !== undefined) process.env.NOEVIA_QA_MCP_REGISTRY = prior; }
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
