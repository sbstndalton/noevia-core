'use strict';
// The JS reference of MCP discovery, kept as a test oracle after the Rust front took it over
// (sbstndalton/noevia row T; noevia-rs bins/noevia-server mcp_discovery_actor.rs). It is the
// `discoverOneServer` / `discoverMcpTools` that server/mcp-wiring.cjs ran, moved here unchanged except
// that its outcome is returned in the shape the front's `POST /v1/mcp/discovery` answers, so tests
// that exercise the EXECUTOR against fake MCP servers (mcp-wiring, routing, rate limits, scopes) keep a
// discovery to run against without a front. The real implementation is differential-tested against
// this logic (noevia-rs tests/mcp_discovery_actor.rs over tests/mcp-discovery-oracle.cjs).
const { bindBoxes: defaultBindBoxes } = require('./mcp-boxes.cjs');

function createReferenceDiscovery({
  servers, manifest = [], mcp, bindBoxes = defaultBindBoxes, directoryMcp, mcpOAuth, mcpKeys = { hasKey: () => false, headers: async () => null }, directoryUrlAllowed,
  publicFetch = null, internal, internalKey, env = process.env, discoveryTtlMs = 10 * 60 * 1000,
  discoveryFailTtlMs = Number(process.env.MCP_DISCOVERY_FAIL_TTL_MS || 30 * 1000), logger = console,
  isUserDisabled = () => false, discoveryRetryMs = [5000, 15000, 45000, 120000],
}) {
  const MCP_SERVERS = servers;
  const publicMcp = publicFetch ? mcp.withFetch(publicFetch) : null;
  const transportFor = (server) => (server && server.directory && publicMcp ? publicMcp : mcp);
  const state = { tools: new Map(), offers: new Map(), boxes: [], servers: new Map(), discoveredAt: 0, failedAt: 0, remoteFailStreak: 0, error: null, inflight: null, generation: 0 };
  let syncedWith = directoryMcp.signal();

  function mcpStaticAuth(server) {
    if (!server || server.auth !== 'bearer' || !server.tokenEnv) return null;
    const token = env[server.tokenEnv];
    return token ? { Authorization: `Bearer ${token}` } : null;
  }
  function mcpDiscoveryAuth(server) {
    if (server && server.auth === 'directory') return directoryMcp.headersFor(server.id);
    if (server && server.auth === 'internal') {
      return { Authorization: `Bearer ${internal.mintToken(internalKey, { discovery: true, ttlMs: 120000 })}` };
    }
    return mcpStaticAuth(server);
  }

  async function discoverOneServer(server) {
    if (server.directory && !(await directoryUrlAllowed(server.url))) throw new Error('its address no longer resolves to a public host');
    let headers = mcpDiscoveryAuth(server);
    if (server.auth === 'personal') {
      if (server.addedBy && isUserDisabled(server.addedBy)) throw new Error('waiting for an active administrator to add a key');
      headers = await mcpKeys.headers(server.addedBy, server.id);
      if (!headers || !Object.keys(headers).length) throw new Error('waiting for the administrator who added it to enter their key');
    }
    if (server.auth === 'oauth') {
      if (server.addedBy && isUserDisabled(server.addedBy)) throw new Error('waiting for an active administrator to sign in');
      const token = await mcpOAuth.tokenFor(server.addedBy, server.id);
      if (!token) throw new Error('waiting for the administrator who added it to sign in');
      headers = { Authorization: `Bearer ${token}` };
    }
    const transport = transportFor(server);
    const { session } = await transport.connect(server.url, headers);
    let discovered;
    try {
      discovered = await transport.listTools(server.url, session, headers);
    } finally {
      await transport.disconnect(server.url, session, headers);
    }
    const byName = new Map();
    const dropped = [];
    for (const t of discovered) {
      const conv = mcp.convertTool(t);
      if (!conv.ok) { dropped.push(`${(t && t.name) || '(unnamed)'}: ${conv.reason}`); continue; }
      byName.set(conv.tool.function.name, { tool: conv.tool, readOnly: mcp.readOnlyHint(t), serverId: server.id });
    }
    if (dropped.length) logger.warn(`[mcp:${server.id}] dropped ${dropped.length} unconvertible tools: ${dropped.join(' | ')}`);
    return byName;
  }

  const credentialKey = () => MCP_SERVERS
    .filter((sv) => sv.auth === 'oauth' || sv.auth === 'personal')
    .map((sv) => `${sv.id}:${sv.auth === 'oauth' ? !!mcpOAuth.connected(sv.addedBy, sv.id) : !!mcpKeys.hasKey(sv.addedBy, sv.id)}`)
    .join('|');
  let discoveredWith;
  async function discoverMcpTools(force = false) {
    const seen = directoryMcp.signal();
    if (seen !== syncedWith) { syncedWith = seen; force = true; }
    const credentials = credentialKey();
    if (!force && discoveredWith !== undefined && credentials !== discoveredWith) force = true;
    if (!MCP_SERVERS.length) { state.tools = new Map(); state.offers = new Map(); state.boxes = []; state.servers = new Map(); state.error = null; state.generation++; return state; }
    const fresh = Date.now() - state.discoveredAt < discoveryTtlMs;
    if (!force && fresh && state.boxes.length) return state;
    const recentFailure = !state.boxes.length && Date.now() - state.failedAt < discoveryFailTtlMs;
    if (!force && recentFailure) return state;
    if (state.inflight && force) { await state.inflight.catch(() => undefined); return discoverMcpTools(true); }
    if (state.inflight) return state.inflight;
    state.inflight = (async () => {
      discoveredWith = credentials;
      try {
        const perServer = new Map();
        const found = new Map();
        await Promise.all(MCP_SERVERS.map(async (server) => {
          try {
            const tools = await discoverOneServer(server);
            perServer.set(server.id, tools);
            found.set(server.id, { ...server, error: null, discoveredAt: Date.now(), toolCount: tools.size });
          } catch (err) {
            const message = String((err && err.message) || err);
            perServer.set(server.id, new Map());
            found.set(server.id, { ...server, error: message, discoveredAt: Date.now(), toolCount: 0 });
          }
        }));
        const byName = new Map();
        const offers = new Map();
        for (const server of MCP_SERVERS) {
          for (const [name, entry] of perServer.get(server.id) || []) {
            if (!offers.has(name)) offers.set(name, new Map());
            offers.get(name).set(server.id, entry);
            if (byName.get(name)) continue;
            byName.set(name, entry);
          }
        }
        const directoryBoxes = MCP_SERVERS.filter((sv) => sv.directory).map((sv) => directoryMcp.boxFor(sv, (perServer.get(sv.id) || new Map()).keys()));
        const boxes = bindBoxes({ manifest: [...manifest, ...directoryBoxes], perServer, servers: found, warn: (line) => logger.warn(line) });
        state.tools = byName; state.offers = offers; state.boxes = boxes; state.servers = found;
        const internalDown = [...found.values()].some((sv) => sv.auth === 'internal' && sv.error);
        const remoteDown = [...found.values()].some((sv) => sv.auth !== 'internal' && sv.error);
        state.remoteFailStreak = remoteDown ? state.remoteFailStreak + 1 : 0;
        const retryMs = remoteDown && discoveryRetryMs.length
          ? Math.min(discoveryTtlMs, discoveryRetryMs[Math.min(state.remoteFailStreak, discoveryRetryMs.length) - 1])
          : discoveryTtlMs;
        state.discoveredAt = internalDown ? 0 : Date.now() - (discoveryTtlMs - retryMs);
        state.failedAt = boxes.length ? 0 : Date.now();
        state.error = [...found.values()].map((sv) => sv.error).find(Boolean) || null;
        state.generation++;
      } finally {
        state.inflight = null;
      }
      return state;
    })();
    return state.inflight;
  }

  /** The front's wire form of the state. */
  function snapshot() {
    return {
      version: 1, generation: state.generation, enabled: MCP_SERVERS.length > 0, error: state.error,
      discoveredAt: state.discoveredAt, failedAt: state.failedAt, remoteFailStreak: state.remoteFailStreak,
      servers: [...state.servers.values()],
      offers: [...state.offers].flatMap(([name, byServer]) => [...byServer].map(([server, e]) => ({ name, server, readOnly: e.readOnly, tool: e.tool }))),
      boxes: state.boxes,
    };
  }
  return Object.freeze({
    async discover({ force = false, generation = null } = {}) {
      await discoverMcpTools(force);
      const snap = snapshot();
      return generation === snap.generation ? { unchanged: true, generation } : snap;
    },
  });
}

module.exports = { createReferenceDiscovery };
