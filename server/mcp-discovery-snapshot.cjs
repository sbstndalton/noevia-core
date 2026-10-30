'use strict';
// What only this process's live MCP client knows, published for the Rust front (sbstndalton/noevia#2202
// round 2): the toolboxes this deployment offers right now with their tools (and whether each tool
// writes), the configured MCP boxes, each MCP server's last discovery (a tool count, the first tools, an
// error), and the two facts of this process that decide the coding harness (it is switched on; a
// repository is registered), plus what the Nextcloud half of Settings -> Connectors needs (whether a
// Nextcloud MCP server is configured, and the origins a credential may be forwarded to).
//
// The front computes GET /api/toolboxes/permitted, GET /api/connectors and the admin directory listing
// from it (noevia-rs bins/noevia-server mcp_discovery.rs); everything per account it reads itself, at the
// time of the request. The file is `mcp-discovery.json`, written by published-snapshot.cjs: atomically,
// mode 0600, as `{ version: 1, kind: 'mcp-discovery', writtenAt, everyMs, ...catalogue }`, only while the
// front asks (the demand marker), and never trusted by the front once it is older than two intervals.
//
// Discovery itself stays here and stays lazy and cached (mcp-wiring.cjs): a publish asks for an
// unforced discovery, which re-reads the directory table (the front writes it) and rediscovers when it
// changed, but it never waits more than DISCOVERY_WAIT_MS for one that is slow: the catalogue as it
// stands is published, and the next one carries the result.
const path = require('node:path');
const published = require('./published-snapshot.cjs');
const { isInAppBox, isManifestBoxInApp } = require('./toolbox-flags.cjs');

const SNAPSHOT_FILE = 'mcp-discovery.json';
const SNAPSHOT_KIND = 'mcp-discovery';
/** The publishing interval; the front calls the file stale after two of them. */
const EVERY_MS = 3000;
const DISCOVERY_WAIT_MS = 1500;

// A tool the front can carry has a text name (discovery guarantees it for MCP tools; a built-in always has one).
const named = (tool) => !!(tool && tool.function && typeof tool.function.name === 'string' && tool.function.name);

/**
 * The catalogue document (no header): pure, from the live objects.
 * @param {object} o
 * @param {() => object[]} o.allToolboxes
 * @param {object[]} o.manifest           the configured MCP boxes, already filtered to the offered ones
 * @param {() => boolean} o.mcpEnabled
 * @param {object[]} o.servers            MCP_SERVERS
 * @param {{ servers: Map, boxes: object[] }} o.state  mcpState
 * @param {(name:string) => boolean} o.isWriteTool
 * @param {() => boolean} o.harnessEnabled
 * @param {() => boolean} o.hasRepositories
 * @param {string[]} o.nextcloudOrigins
 * @param {string[]} o.defaultToolboxes
 * @param {Iterable<string>} o.connectorBoxes
 */
function buildCatalogue({ allToolboxes, manifest, mcpEnabled, servers, state, isWriteTool, harnessEnabled, hasRepositories, nextcloudOrigins, defaultToolboxes, connectorBoxes }) {
  const enabled = mcpEnabled();
  return {
    mcpEnabled: !!enabled,
    harnessEnabled: !!harnessEnabled(),
    hasRepositories: !!hasRepositories(),
    nextcloudConfigured: servers.some((sv) => sv.auth === 'nextcloud'),
    nextcloudOrigins: [...nextcloudOrigins],
    defaults: [...defaultToolboxes],
    connectorBoxes: [...connectorBoxes],
    boxes: allToolboxes().map((b) => ({
      id: String(b.id), label: b.label, description: b.description, source: b.source, inApp: isInAppBox(b),
      server: typeof b.server === 'string' && b.server ? b.server : null,
      tools: (b.tools || []).filter(named).map((t) => ({
        name: t.function.name, description: String(t.function.description || '').slice(0, 240), write: !!isWriteTool(t.function.name),
      })),
    })),
    manifest: enabled ? manifest.map((e) => ({ id: e.id, label: e.label || e.id, description: e.description || '', inApp: isManifestBoxInApp(e) })) : [],
    // Each server's last discovery, as the admin directory shows it: the tools actually bound to its own
    // box (not the global name registry, where collisions can hide a server's own tools).
    servers: servers.map((sv) => {
      const st = state.servers.get(sv.id);
      const box = sv.directory ? (state.boxes || []).find((b) => b.directory && b.server === sv.id && b.id === sv.id) : null;
      const tools = (box?.tools || []).slice(0, 40).map((t) => ({
        name: String(t.function?.name || '').slice(0, 120), description: String(t.function?.description || '').slice(0, 240),
      }));
      return {
        id: sv.id, auth: sv.auth, directory: !!sv.directory, error: st?.error || null, toolCount: st?.toolCount ?? null,
        tools, toolsTruncated: (box?.tools?.length || 0) > tools.length,
      };
    }),
  };
}

/**
 * The demand-driven publisher of the catalogue.
 * @param {object} o
 * @param {string} o.dataDir
 * @param {() => Promise<unknown>} o.discoverMcpTools  unforced; re-reads the directory itself
 * @param {() => object} o.catalogue                   buildCatalogue over the live objects
 * @param {object} [o.demand]                           the process's shared demand source (published-snapshot.cjs createDemand)
 */
function createMcpDiscoveryPublisher({ dataDir, discoverMcpTools, catalogue, demand: shared = null, onError = (err) => console.warn(`[mcp-discovery] not published: ${err && err.message}`), everyMs = EVERY_MS, waitMs = DISCOVERY_WAIT_MS, now = Date.now }) {
  // The process shares one demand source between its publishers (index.cjs) and starts it itself; a publisher made
  // alone (tests) makes and starts its own.
  const demand = shared || published.createDemand({ dir: dataDir, now });
  const publisher = published.createPublisher({
    file: path.join(dataDir, SNAPSHOT_FILE), kind: SNAPSHOT_KIND, everyMs, demand, onError, now,
    async build() {
      let timer;
      try {
        await Promise.race([
          Promise.resolve().then(() => discoverMcpTools()).catch(() => undefined),
          new Promise((resolve) => { timer = setTimeout(resolve, waitMs); }),
        ]);
      } finally { clearTimeout(timer); }
      return catalogue();
    },
  });
  return Object.freeze({
    start() { if (!shared) demand.start(); publisher.start(); },
    stop() { publisher.stop(); if (!shared) demand.stop(); },
    publish: () => publisher.publish(),
    demand,
  });
}

module.exports = { SNAPSHOT_FILE, SNAPSHOT_KIND, EVERY_MS, buildCatalogue, createMcpDiscoveryPublisher };
