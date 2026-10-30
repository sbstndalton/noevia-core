'use strict';
const { readCappedText } = require('../http.cjs');
// The plugin directory library the Node-owned routes still use: only `fetchPublishedSkill`, for a project skill
// (routes/projects.cjs). GET /api/plugins/directory itself (the MCP registry and skills listings, the starters,
// the cache) is the Rust front's (sbstndalton/noevia#2190, noevia-rs bins/noevia-server plugin_directory_routes.rs;
// Node refuses it in rust-plugin-directory.cjs), and so is the registry lookup that adding a directory MCP server
// needs (sbstndalton/noevia#2202 round 2, mcp_directory_routes.rs: the registry mapping, the header rules and the
// lookup were deleted here). Only fixed hosts are fetched.

/**
 * Fetch one published skill's SKILL.md (only SKILL.md: scripts and assets are never fetched or
 * run). Fixed host, validated name, 32 KiB cap, and the result must be valid skill frontmatter.
 */
async function fetchPublishedSkill(name, { fetchImpl = globalThis.fetch } = {}) {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(String(name || ''))) throw Object.assign(new Error('Unknown skill'), { status: 400 });
  const r = await fetchImpl(`https://raw.githubusercontent.com/anthropics/skills/main/skills/${name}/SKILL.md`, { headers: { 'user-agent': 'noevia' }, redirect: 'error', signal: AbortSignal.timeout(8000) });
  if (r.status === 404) throw Object.assign(new Error('That skill has no SKILL.md'), { status: 404 });
  if (!r.ok) throw Object.assign(new Error('The skills repository could not be reached right now.'), { status: 502 });
  const { text: content, capped } = await readCappedText(r, 32768);
  if (capped) throw Object.assign(new Error('That skill is larger than the 32 KiB limit for project skills.'), { status: 422 });
  return content;
}

module.exports = { fetchPublishedSkill };
