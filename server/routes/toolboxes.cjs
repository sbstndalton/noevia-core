'use strict';
// GET /api/toolboxes -> the picker's view: every box a project may choose, what each costs
// per turn, what has been measured about prefill on this hardware, and MCP discovery state.
//
// Returns true when it handled the request. Auth runs before routes are mounted; the box
// list itself is toolboxes.cjs and the MCP server summary is mcp-status.cjs.
// GET /api/toolboxes/permitted?projectId=&mode=chat|cowork -> the tools this account could use
// THIS turn, with permission state (#237). Computed in toolboxes-permitted.cjs, cached per
// account/project/mode for a short TTL; the client refetches on project or mode change.
const { describeMcpServers } = require('../mcp-status.cjs');
const { createTtlCache } = require('../toolboxes-permitted.cjs');

/**
 * @param {object} deps
 * @param {() => Promise<void>} deps.discoverMcpTools  awaited so a cold start still lists MCP boxes
 * @param {() => object[]} deps.toolboxSummaries
 * @param {{ targetMs:number, stats:() => object }} deps.prefill
 * @param {() => { enabled:boolean, state:object, servers:object[], manifest:object[] }} deps.mcp
 *        read at call time: MCP_ENABLED and the server list change when directory servers sync
 * @param {(res, status, body) => any} deps.json
 * @param {(input:{ authn:object, projectId:string|null, mode:'chat'|'cowork' }) => ({ project:object|null, boxes:object[] } | null)} [deps.permitted]
 *        null when the project is not this account's (the caller's getProject is tenant-scoped)
 * @param {{ get:(k:string)=>any, set:(k:string, v:any)=>void }} [deps.cache]
 */
function createToolboxRoutes({ discoverMcpTools, toolboxSummaries, prefill, mcp, json, permitted = null, cache = createTtlCache({ ttlMs: 30000 }) }) {
  return async function toolboxRoutes(req, res, { path, authn, url }) {
    if (path === '/api/toolboxes/permitted' && permitted) {
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' }), true;
      if (!authn) return json(res, 401, { error: 'sign in first' }), true;
      const params = url && url.searchParams ? url.searchParams : new URLSearchParams();
      const projectId = params.get('projectId') || null;
      const mode = params.get('mode') || 'chat';
      if (mode !== 'chat' && mode !== 'cowork') return json(res, 400, { error: 'mode must be "chat" or "cowork"' }), true;
      const key = JSON.stringify([authn.user.id, authn.user.role, projectId, mode]);
      let view = cache.get(key);
      if (!view) {
        await discoverMcpTools();
        const result = permitted({ authn, projectId, mode });
        if (!result) return json(res, 404, { error: 'project not found' }), true;
        view = { mode, projectId, boxes: result.boxes, computedAt: Date.now() };
        cache.set(key, view);
      }
      return json(res, 200, view), true;
    }
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
