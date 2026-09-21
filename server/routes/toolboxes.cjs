'use strict';
// GET /api/toolboxes -> the picker's view: every box a project may choose, what each costs
// per turn, what has been measured about prefill on this hardware, and MCP discovery state.
//
// Returns true when it handled the request. Auth runs before routes are mounted; the box
// list itself is toolboxes.cjs and the MCP server summary is mcp-status.cjs.
const { describeMcpServers } = require('../mcp-status.cjs');

/**
 * @param {object} deps
 * @param {() => Promise<void>} deps.discoverMcpTools  awaited so a cold start still lists MCP boxes
 * @param {() => object[]} deps.toolboxSummaries
 * @param {{ targetMs:number, stats:() => object }} deps.prefill
 * @param {() => { enabled:boolean, state:object, servers:object[], manifest:object[] }} deps.mcp
 *        read at call time: MCP_ENABLED and the server list change when directory servers sync
 * @param {(res, status, body) => any} deps.json
 */
function createToolboxRoutes({ discoverMcpTools, toolboxSummaries, prefill, mcp, json }) {
  return async function toolboxRoutes(req, res, { path }) {
    if (path !== '/api/toolboxes') return false;
    if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' }), true;
    // Await discovery: on a cold start the picker would otherwise show only the built-in
    // box and the user would think MCP was broken. Discovery caches itself, so this is one
    // round trip every MCP_DISCOVERY_TTL_MS.
    await discoverMcpTools();
    const { enabled, state, servers, manifest } = mcp();
    json(res, 200, {
      toolboxes: toolboxSummaries(),
      // What has actually been measured about this hardware, so a slow box is diagnosable
      // without reading logs.
      prefill: { targetMs: prefill.targetMs, models: prefill.stats() },
      mcp: enabled
        ? { configured: true, error: state.error, discovered: state.tools.size, servers: describeMcpServers(servers, state.servers, state.tools, manifest) }
        : { configured: false },
    });
    return true;
  };
}

module.exports = { createToolboxRoutes };
