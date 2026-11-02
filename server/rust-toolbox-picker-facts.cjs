'use strict';
// #2281: live discovery and observed prefill are still produced by the chat process. The Rust
// front owns the picker response, token estimates, account filtering and MCP status composition.
const { trustedFront } = require('./trusted-front.cjs');
const PATH = '/internal/toolbox-picker/facts';
const MAX_BYTES = 8 * 1024 * 1024;
const AUTH_KINDS = new Set(['none', 'bearer', 'nextcloud', 'personal', 'oauth', 'internal', 'directory']);
function serverFacts(s) {
  if (!AUTH_KINDS.has(s.auth) || typeof s.id !== 'string') throw Error('Invalid discovery server');
  return { id: s.id, auth: s.auth, directory: !!s.directory, ...(typeof s.title === 'string' ? { title: s.title } : {}) };
}

function createToolboxPickerFacts({ secret, discoverMcpTools, allToolboxes, connectorBoxes, prefill, mcp, json, readJson, log = m => console.warn(m) }) {
  return async function handle(req, res) {
    if (String(req.url || '').split('?')[0] !== PATH) return false;
    if (!trustedFront(req, secret) || Object.hasOwn(req.headers, 'x-noevia-client-ip') || Object.hasOwn(req.headers, 'x-forwarded-for') || req.method !== 'POST') { json(res, 404, { error: 'Not found' }); return true; }
    let body;
    try { body = await readJson(req); } catch { json(res, 400, { error: 'invalid JSON' }); return true; }
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) {
      json(res, 400, { error: 'An empty facts request is required.' }); return true;
    }
    try {
      await discoverMcpTools();
      const { enabled, state, servers, manifest } = mcp();
      const facts = {
        boxes: allToolboxes().map(b => ({ id: b.id, label: b.label, description: b.description, source: b.source, inApp: b.inApp, tools: b.tools })),
        connectorBoxes: [...connectorBoxes],
        prefill: { targetMs: prefill.targetMs, models: prefill.stats() },
        mcp: { enabled: !!enabled, error: typeof state?.error === 'string' ? state.error : null,
          tools: [...(state?.tools || new Map())].map(([name, tool]) => ({ name, serverId: tool.serverId })),
          states: [...(state?.servers || new Map())].map(([id, st]) => ({ id, error: typeof st?.error === 'string' ? st.error : null, toolCount: st?.toolCount, discoveredAt: st?.discoveredAt })),
          servers: (servers || []).map(serverFacts),
          manifest: (manifest || []).map(b => ({ server: b.server, tools: b.tools })),
        },
      };
      if (Buffer.byteLength(JSON.stringify(facts)) > MAX_BYTES) throw Object.assign(Error('facts over cap'), { code: 'FACTS_TOO_LARGE' });
      json(res, 200, facts);
    } catch (e) {
      log(`[toolbox-picker] facts failed: ${e?.code || e?.name || 'error'}`);
      json(res, 503, { error: 'Toolbox facts are unavailable.' });
    }
    return true;
  };
}
module.exports = { createToolboxPickerFacts, PATH, MAX_BYTES };
