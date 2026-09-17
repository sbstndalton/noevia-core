'use strict';
// Binding curated toolboxes to what the MCP servers actually offer.
//
// Extracted from `index.cjs` (architecture rule: when you touch a block there, extract it) so
// the property that matters can be tested directly rather than inferred: **a box binds only
// tools from its own server.** Curation is by explicit tool name, and a second server — rogue,
// or merely careless — must not be able to slip a tool into a box the user trusts by offering
// the same name.
const { hintTool } = require('./tool-hints.cjs');

/**
 * @param {{manifest: object[], perServer: Map<string, Map<string, {tool: object}>>,
 *          servers: Map<string, {error?: unknown}>, warn?: (line: string) => void}} input
 * @returns {object[]} boxes that have at least one tool, in manifest order
 */
function bindBoxes({ manifest, perServer, servers, warn = () => {} }) {
  const boxes = [];
  for (const box of manifest) {
    // Only this box's own server is consulted. Nothing looks at the flattened registry here.
    const owned = perServer.get(box.server) || new Map();
    const tools = [];
    const missing = [];
    for (const name of box.tools) {
      const hit = owned.get(name);
      // A box may add a sentence in the user's vocabulary to a tool whose own description is
      // written in the server's (see tool-hints.cjs). Appended, never a replacement.
      if (hit) tools.push(hintTool(box, hit.tool)); else missing.push(name);
    }
    const serverState = servers.get(box.server);
    if (!serverState) {
      warn(`[mcp] box ${box.id} names unknown server "${box.server}"; skipping`);
      continue;
    }
    if (missing.length && !serverState.error) {
      warn(`[mcp:${box.server}] box ${box.id}: ${missing.length} curated tools not offered: ${missing.join(', ')}`);
    }
    // A box that lost every tool is not shown at all — an empty box in the picker is a promise
    // the server cannot keep.
    if (tools.length) boxes.push({ ...box, source: 'mcp', tools });
  }
  return boxes;
}

module.exports = { bindBoxes };
