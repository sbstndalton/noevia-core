'use strict';
// Synthetic fixture for the #615 tests: every box noevia ships (the built-in core, the two
// built-in add-ons and every box of the real MCP manifest), bound the way discovery binds them,
// so a test can ask each server path what it says about each one. No network, no data dir.
const { AsyncLocalStorage } = require('node:async_hooks');
const { createToolboxes } = require('./toolboxes.cjs');
const { bindBoxes } = require('./mcp-boxes.cjs');
const { buildToolboxManifest } = require('./mcp-toolbox-manifest.cjs');

const fn = (name) => ({ type: 'function', function: { name, description: 'synthetic', parameters: { type: 'object', properties: {} } } });

function buildInAppBoxes() {
  const manifest = buildToolboxManifest({ features: { enabled: () => true } });
  const perServer = new Map();
  for (const box of manifest) {
    const owned = perServer.get(box.server) || new Map();
    for (const name of box.tools) owned.set(name, { tool: fn(name) });
    perServer.set(box.server, owned);
  }
  const mcpBoxes = bindBoxes({ manifest, perServer, servers: new Map([...perServer.keys()].map((id) => [id, {}])) });
  const drive = { id: 'gdrive', label: 'Google Drive', description: 'Drive', source: 'builtin', tools: [fn('gdrive_search')], reads: ['gdrive_search'] };
  const wiki = { id: 'offline-wikipedia', label: 'Offline Wikipedia', description: 'Wiki', source: 'builtin', tools: [fn('wiki_search')], reads: ['wiki_search'] };
  const api = createToolboxes({
    boxes: [wiki, drive], driveTools: { names: new Set(['gdrive_search']), connected: () => true, execute: async () => '' },
    mcpBoxes: () => mcpBoxes, mcpTools: () => new Map(), offered: () => true,
    prefill: { budgetFor: () => null, rateFor: () => 0 }, scope: new AsyncLocalStorage(),
    getProject: (id) => ({ id, files: [] }), documentSources: { notice: () => '', readPages: () => { throw new Error('no pages'); } },
    workspace: () => ({ dir: '/nowhere' }),
  });
  return { ...api, manifest };
}

module.exports = { buildInAppBoxes };
