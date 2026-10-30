'use strict';
const test = require('node:test');
const assert = require('node:assert');
// GET /api/plugins/directory and the registry lookup for adding an MCP server are the Rust front's (#2190, #2202;
// tested there). This covers the one lookup the Node-owned project skill routes use.

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
