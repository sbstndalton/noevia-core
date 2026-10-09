'use strict';

// TEST ORACLE (#1071): never required by production code (server/oracle-isolation.test.cjs
// enforces that). The JS references of the MCP server list, the curated-box filter and
// toolboxOffered, kept only so tools/gen-mcp-servers-fixtures.cjs can regenerate
// tests/fixtures/mcp-servers.v1.json and the differential tests can compare them with
// dav-parse.wasm (sbstndalton/noevia-rs crates/mcp-servers). Production decides through the Rust
// module alone (server/mcp-servers.cjs), which keeps walkMcpServers and shapeOkWith to hold every
// server the port returns to the JS rules again.
// Moved here unchanged from server/mcp-servers.cjs parseMcpServersJs, parseEnabledToolboxesJs and
// createToolboxOfferedJs.

const { walkMcpServers, shapeOkWith } = require('../../../server/mcp-servers.cjs');

function parseMcpServersJs(env = process.env) {
  const shapeOk = shapeOkWith((m) => console.warn(m));
  const list = (env.MCP_SERVERS || '').trim();
  if (list) return walkMcpServers(list, env, (m) => console.warn(m));

  const single = (env.MCP_SERVER_URL || '').trim();
  if (!single) return [];
  if (!shapeOk(single, 'MCP_SERVER_URL')) return [];
  // The historical single-server deployment is the Nextcloud MCP, and it has
  // always received the credential — keep that exactly.
  return [{ id: 'nextcloud', url: single, auth: 'nextcloud' }];
}

// Which curated boxes are actually offered. Curation says what a box WOULD
// contain; this says whether anyone wants it. Unset means all of them.
//
// Separate from the manifest on purpose: a deployment that has no use for
// Cookbook should not have to delete its curation to stop seeing it, and
// turning it back on should be one environment variable rather than a commit.
function parseEnabledToolboxesJs(env = process.env) {
  const raw = (env.ENABLED_TOOLBOXES || '').trim();
  if (!raw) return null; // null means "no opinion" — offer everything
  const ids = raw.split(',').map((x) => x.trim()).filter(Boolean);
  return ids.length ? new Set(ids) : null;
}

function createToolboxOfferedJs(ENABLED_TOOLBOXES) {
  return function toolboxOffered(id) {
  // core is built-in and always safe, so it is never filtered out — a
  // deployment that named only MCP boxes should not lose the clock.
  if (id === 'core') return true;
  // An administrator adding a directory server is the opt-in; ENABLED_TOOLBOXES curates the operator's boxes.
  if (id.startsWith('dir-')) return true;
  return !ENABLED_TOOLBOXES || ENABLED_TOOLBOXES.has(id);
  };
}

module.exports = { parseMcpServersJs, parseEnabledToolboxesJs, createToolboxOfferedJs };
