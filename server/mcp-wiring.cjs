'use strict';
// ── MCP wiring ────────────────────────────────────────────────────────────
// How noevia talks to MCP servers at runtime: the live server list (operator
// entries plus directory entries an administrator added), lazy cached
// discovery with per-server failure, which credential each server mode gets
// (nextcloud pass-through, a static bearer, a per-account key or sign-in, or
// a capability token for noevia's own internal server), and the executor
// that runs one discovered tool. The MCP protocol itself is mcp.cjs; the
// curated boxes are mcp-boxes.cjs; the directory and OAuth stores are
// injected, so this module holds no database and tests need no server.

/** Whether a directory server's address may be used at all. Directory servers
 *  are strangers' metadata, so only a public host is acceptable — except that
 *  QA (NOEVIA_QA_ALLOW_LOOPBACK_MCP=1) may stand a synthetic server on
 *  127.0.0.1 in for one. */
function createDirectoryUrlAllowed({ isPublicUrl, allowLoopback = false }) {
  return async function directoryUrlAllowed(url) {
    if (allowLoopback && /^https?:\/\/127\.0\.0\.1:\d+\//.test(url)) return true;
    return isPublicUrl(url);
  };
}

// Origins whose stored credential may be forwarded to a nextcloud-mode MCP
// server.
//
// This guard exists because the two ends can disagree. The MCP server talks to
// ONE Nextcloud, fixed by its own NEXTCLOUD_HOST. noevia stores whatever
// server each user happened to connect for diary storage — which may be a
// different host entirely. Forwarding a credential across that gap would hand
// a user's password for their server to somebody else's, so pass-through is
// allowed only for origins the operator has explicitly declared to be the same
// Nextcloud the MCP server uses.
//
// It is a LIST because one Nextcloud legitimately has several origins: a LAN
// address and a public name. Unset means no pass-through at all — MCP tools
// then return an actionable error instead of silently leaking, which is the
// correct way to fail.
function parseNextcloudOrigins(value) {
  return String(value || '').split(',').map((x) => x.trim().replace(/\/+$/, '')).filter(Boolean);
}

function createCredentialOriginCheck(origins) {
  const list = Array.isArray(origins) ? origins : parseNextcloudOrigins(origins);
  return function mcpCredentialOriginAllowed(baseUrl) {
    try {
      return list.includes(new URL(baseUrl).origin);
    } catch { return false; }
  };
}

/**
 * @param {object} deps
 * @param {object[]} deps.servers        the MCP_SERVERS array; mutated in place when directory servers sync
 * @param {object[]} deps.manifest       curated boxes (mcp-toolbox-manifest.cjs)
 * @param {object} deps.mcp              the protocol client: connect, listTools, callTool, disconnect, convertTool, readOnlyHint, resultToText
 * @param {(opts) => object[]} deps.bindBoxes   mcp-boxes.cjs
 * @param {object} deps.directoryMcp     asServers, boxFor, headersFor, userHeadersFor, hasUserKey
 * @param {object} deps.mcpOAuth         connected, tokenFor
 * @param {(url) => Promise<boolean>} deps.directoryUrlAllowed
 * @param {(baseUrl) => boolean} deps.credentialOriginAllowed
 * @param {{ getStore() }} deps.scope    the request scope: { workspace:{userId}, authn:{user}, internalCallProject }
 * @param {(userId) => object} deps.storageFor    the account's storage connection (kind, baseUrl, username, secret)
 * @param {(name) => boolean} deps.isWriteTool
 * @param {{ mintToken(key, claims) }} deps.internal   mcp-internal.cjs
 * @param {string|Buffer} deps.internalKey
 * @param {(text, opts) => { text, reduced }} deps.reduceToolResult
 * @param {number} deps.resultCap
 * @param {NodeJS.ProcessEnv} [deps.env]   for a bearer server's tokenEnv
 * @param {(url, init) => Promise<Response>} [deps.fetch]
 * @param {number} [deps.discoveryTtlMs]
 * @param {{ log, warn }} [deps.logger]
 */
function createMcpWiring({
  servers, manifest = [], mcp, bindBoxes, directoryMcp, mcpOAuth, directoryUrlAllowed, credentialOriginAllowed,
  scope, storageFor, isWriteTool, internal, internalKey, reduceToolResult, resultCap = 8000,
  env = process.env, fetch = globalThis.fetch, discoveryTtlMs = 10 * 60 * 1000, logger = console,
}) {
  const MCP_SERVERS = servers;
  // Servers an administrator added from the public registry join the operator's list (after it,
  // so an operator's server keeps any tool name both offer). See directory-mcp.cjs.
  for (const sv of directoryMcp.asServers()) MCP_SERVERS.push(sv);
  const MCP_SERVER_BY_ID = new Map(MCP_SERVERS.map((sv) => [sv.id, sv]));
  let MCP_ENABLED = MCP_SERVERS.length > 0;

  const oauthServerIds = () => new Set(MCP_SERVERS.filter((sv) => sv.auth === 'oauth' || sv.auth === 'personal').map((sv) => sv.id));
  /** Whether this account can use a per-account server: its own sign-in or its own key. */
  function accountReady(userId, serverId) {
    const sv = MCP_SERVERS.find((x) => x.id === serverId);
    if (!sv) return false;
    return sv.auth === 'oauth' ? mcpOAuth.connected(userId, serverId) : sv.auth === 'personal' ? directoryMcp.hasUserKey(userId, serverId) : true;
  }
  /** An unauthenticated initialize: tells us whether a server wants OAuth (401 + WWW-Authenticate). */
  async function probeMcpAuth(url) {
    if (!(await directoryUrlAllowed(url))) return { status: 0, challenge: '' };
    try {
      const r = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'noevia', version: '1' } } }) });
      return { status: r.status, challenge: r.headers.get('www-authenticate') || '' };
    } catch { return { status: 0, challenge: '' }; }
  }
  function syncDirectoryServers() {
    for (let i = MCP_SERVERS.length - 1; i >= 0; i--) if (MCP_SERVERS[i].directory) MCP_SERVERS.splice(i, 1);
    for (const sv of directoryMcp.asServers()) MCP_SERVERS.push(sv);
    MCP_SERVER_BY_ID.clear();
    for (const sv of MCP_SERVERS) MCP_SERVER_BY_ID.set(sv.id, sv);
    MCP_ENABLED = MCP_SERVERS.length > 0;
  }

  // Being unconfigured is a healthy state, but it is indistinguishable from a
  // broken one from the outside: a curated box that loses every tool is not
  // rendered at all, so the toolboxes simply are not there and it reads as the
  // feature having been removed. On 2026-09-15 that was a real outage — the live
  // Compose file had been copied without the MCP keys. Name the variable, so the
  // log says what to set rather than only that something is off.
  if (!MCP_ENABLED) {
    logger.warn('[mcp] disabled: neither MCP_SERVERS nor MCP_SERVER_URL is set, so only the built-in `core` toolbox is offered. Set MCP_SERVERS to `id|url|auth` entries to enable connected tools.');
  }

  // Discovered MCP tools, keyed by name, plus the boxes that survived curation.
  // Discovery is a network round trip against servers that may be down, so it is
  // lazy, cached, and failure is non-fatal and PER SERVER: one dead side-car must
  // not remove the tools of a healthy one. Chat must never break because a
  // side-car is restarting.
  //
  // `tools` maps a tool name to the server that offers it, because a call has to
  // be routed back to the right one — and because a box may only bind tools from
  // the server it declares, so a second server cannot quietly take over a
  // curated box by offering a tool of the same name.
  const mcpState = {
    tools: new Map(), // name -> { tool, readOnly, serverId }
    boxes: [],
    servers: new Map(), // id -> { id, url, auth, error, discoveredAt, toolCount }
    discoveredAt: 0,
    error: null,
    inflight: null,
  };

  /** A server's own service token, if it was configured with one. Distinct from
   *  mcpAuthHeaders, which forwards the USER's Nextcloud credential — this is a
   *  single key belonging to noevia's deployment, identical for everyone. */
  function mcpStaticAuth(server) {
    if (!server || server.auth !== 'bearer' || !server.tokenEnv) return null;
    const token = env[server.tokenEnv];
    return token ? { Authorization: `Bearer ${token}` } : null;
  }

  // Per-user credential pass-through, following the diaryHeaders() precedent.
  //
  // The MCP server runs in multi_user_basic mode: it stores no credential of its
  // own and builds a Nextcloud client per request from the Authorization header.
  // noevia already holds exactly the credential that wants — the per-user
  // Nextcloud app password obtained for storage — so the consent the user has
  // already given is reused rather than asked for a second time.
  //
  // Both 'nextcloud' and 'webdav' connections qualify: a Nextcloud app password
  // is the same secret whichever way the user attached it, and in practice the
  // generic WebDAV form is common. The origin allowlist, not the `kind` label,
  // is what makes this safe.
  function mcpAuthHeaders() {
    const store = scope.getStore();
    const workspace = store && store.workspace;
    if (!workspace) return null;
    const storage = storageFor(workspace.userId);
    if (!['nextcloud', 'webdav'].includes(storage.kind)) return null;
    if (!storage.username || !storage.secret) return null;
    if (!credentialOriginAllowed(storage.baseUrl)) {
      logger.warn(`[mcp] refusing to forward credentials for ${storage.baseUrl}: origin not in MCP_NEXTCLOUD_ORIGINS`);
      return null;
    }
    const basic = Buffer.from(`${storage.username}:${storage.secret}`).toString('base64');
    return { Authorization: `Basic ${basic}`, 'X-Cowork-User-ID': workspace.userId };
  }

  /** Which project the in-flight tool call belongs to. executeMcpToolCall is
   *  reached from executeToolCall, which knows; rather than changing the
   *  signature of a function three other call sites share, the project rides in
   *  the request scope for the length of one await.
   *
   *  This used to be a module-level `let`, set immediately before the call and
   *  cleared in a finally, on the reasoning that Node is single-threaded. Node
   *  is single-threaded but NOT non-reentrant: two chats calling internal tools
   *  interleave at the await, and whichever set it last wins for both. Since
   *  this value decides which project a capability token is minted for, the
   *  losing chat would act against the other's project. AsyncLocalStorage keeps
   *  it per call chain, which is what was meant all along. */
  function internalCallProjectId() {
    const project = scope.getStore()?.internalCallProject;
    return project ? project.id : null;
  }

  /** A capability token for one call to noevia's own MCP server.
   *
   *  Unlike the other modes this is not a credential at all — the caller is
   *  this process. What it carries is WHICH user and project the call acts for,
   *  bound by an HMAC so the call cannot claim a different one, and whether a
   *  write has been approved. Fresh per call, valid for 30 seconds.
   *
   *  `w` is safe to derive from isWriteTool here because this is only reached
   *  from executeToolCall, which the permission gate has already let through:
   *  a write that was declined returns before ever getting here. */
  function mcpInternalAuth(name) {
    const workspace = scope.getStore()?.workspace;
    if (!workspace) return null;
    const token = internal.mintToken(internalKey, {
      uid: workspace.userId,
      pid: internalCallProjectId(),
      w: isWriteTool(name) ? 1 : 0,
    });
    return { Authorization: `Bearer ${token}` };
  }

  /** Discovery runs with no user in scope, so it gets a token that can list the
   *  catalogue and can never call anything. The catalogue is static and
   *  identical for everyone, so this leaks nothing. Longer-lived than a call
   *  token because listTools paginates, and harmless because it cannot act. */
  function mcpDiscoveryAuth(server) {
    if (server && server.auth === 'directory') return server.pendingHeaders || directoryMcp.headersFor(server.id);
    if (server && server.auth === 'internal') {
      return { Authorization: `Bearer ${internal.mintToken(internalKey, { discovery: true, ttlMs: 120000 })}` };
    }
    return mcpStaticAuth(server);
  }

  async function discoverOneServer(server) {
    // Discovery lists the catalogue only. A per-USER credential is attached at
    // call time instead (see mcpAuthHeaders), but a static service token has to
    // be present here or the server has nothing to list.
    // A directory server is someone else's: re-check at every discovery that its name still points
    // at a public address, so a DNS change cannot turn it into a probe of the home network.
    if (server.directory && !(await directoryUrlAllowed(server.url))) throw new Error('its address no longer resolves to a public host');
    let headers = mcpDiscoveryAuth(server);
    if (server.auth === 'personal') {
      // The tool list is read with the key of the administrator who added the server.
      headers = server.pendingHeaders || directoryMcp.userHeadersFor(server.addedBy, server.id);
      if (!Object.keys(headers).length) throw new Error('waiting for the administrator who added it to enter their key');
    }
    if (server.auth === 'oauth') {
      // The tool list is read with the sign-in of the administrator who added the server.
      const token = await mcpOAuth.tokenFor(server.addedBy, server.id);
      if (!token) throw new Error('waiting for the administrator who added it to sign in');
      headers = { Authorization: `Bearer ${token}` };
    }
    const { session } = await mcp.connect(server.url, headers);
    let discovered;
    try {
      discovered = await mcp.listTools(server.url, session, headers);
    } finally {
      await mcp.disconnect(server.url, session, headers);
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

  async function discoverMcpTools(force = false) {
    // No servers left (the last directory server was just removed): nothing may stay offered.
    if (!MCP_ENABLED) { mcpState.tools = new Map(); mcpState.boxes = []; mcpState.servers = new Map(); mcpState.error = null; return mcpState; }
    const fresh = Date.now() - mcpState.discoveredAt < discoveryTtlMs;
    if (!force && fresh && mcpState.boxes.length) return mcpState;
    // A forced refresh (a server was just added or removed) must not reuse a discovery that
    // started before the change: wait for it, then discover again with the new list.
    if (mcpState.inflight && force) { await mcpState.inflight.catch(() => undefined); return discoverMcpTools(true); }
    if (mcpState.inflight) return mcpState.inflight;
    mcpState.inflight = (async () => {
      try {
        const perServer = new Map();
        const found = new Map();
        await Promise.all(MCP_SERVERS.map(async (server) => {
          try {
            const tools = await discoverOneServer(server);
            perServer.set(server.id, tools);
            found.set(server.id, { ...server, error: null, discoveredAt: Date.now(), toolCount: tools.size });
            logger.log(`[mcp:${server.id}] discovered ${tools.size} tools at ${server.url}`);
          } catch (err) {
            const message = String((err && err.message) || err);
            perServer.set(server.id, new Map());
            found.set(server.id, { ...server, error: message, discoveredAt: Date.now(), toolCount: 0 });
            logger.warn(`[mcp:${server.id}] discovery failed for ${server.url}: ${message}`);
          }
        }));

        // Flatten into one registry. A name offered by two servers keeps the
        // first — declaration order in MCP_SERVERS is the tie-break, and the
        // collision is logged rather than silently resolved.
        const byName = new Map();
        for (const server of MCP_SERVERS) {
          for (const [name, entry] of perServer.get(server.id) || []) {
            const held = byName.get(name);
            if (held) {
              logger.warn(`[mcp] "${name}" offered by both "${held.serverId}" and "${server.id}"; keeping "${held.serverId}"`);
              continue;
            }
            byName.set(name, entry);
          }
        }

        // A box binds only tools from its own server, so a rogue or merely careless second
        // server cannot inject a tool into a curated box. See mcp-boxes.cjs.
        // Each directory server becomes one box holding every tool it offers (and only its own).
        const directoryBoxes = MCP_SERVERS.filter((sv) => sv.directory).map((sv) => directoryMcp.boxFor(sv, (perServer.get(sv.id) || new Map()).keys()));
        const boxes = bindBoxes({ manifest: [...manifest, ...directoryBoxes], perServer, servers: found, warn: (line) => logger.warn(line) });

        mcpState.tools = byName;
        mcpState.boxes = boxes;
        mcpState.servers = found;
        // The internal server is this process. If it did not answer, something
        // is starting up or broken here, not on a remote host that needs ten
        // minutes of backoff — retry on the next request instead of hiding its
        // boxes for the whole TTL.
        const internalDown = [...found.values()].some((sv) => sv.auth === 'internal' && sv.error);
        mcpState.discoveredAt = internalDown ? 0 : Date.now();
        // Kept for the single-server status shape: the first error, if any.
        mcpState.error = [...found.values()].map((sv) => sv.error).find(Boolean) || null;
        logger.log(`[mcp] ${byName.size} tools across ${MCP_SERVERS.length} server(s); ${boxes.length} curated boxes available`);
      } finally {
        mcpState.inflight = null;
      }
      return mcpState;
    })();
    return mcpState.inflight;
  }

  async function executeMcpToolCall(name, args) {
    const known = mcpState.tools.get(name);
    if (!known) return `ERROR: unknown tool "${name}"`;
    const server = MCP_SERVER_BY_ID.get(known.serverId);
    if (!server) return `ERROR: tool "${name}" belongs to MCP server "${known.serverId}", which is no longer configured`;

    // Credentials are per server. Forwarding the user's Nextcloud password to a
    // server that merely happens to be configured would hand their password to
    // somebody else's service, so only a server the operator marked
    // auth=nextcloud gets it — and then only if the origin allowlist agrees.
    let auth = null;
    if (server.auth === 'personal') {
      // Each account's own key, never another's.
      auth = directoryMcp.userHeadersFor(scope.getStore()?.authn?.user?.id, server.id);
      if (!Object.keys(auth).length) return `ERROR: ${name} needs your own key for ${server.title || 'this server'}: Plugins → Connected → Add key.`;
    } else if (server.auth === 'oauth') {
      // Each account's own sign-in, never another's.
      const token = await mcpOAuth.tokenFor(scope.getStore()?.authn?.user?.id, server.id);
      if (!token) return `ERROR: ${name} needs you to sign in to ${server.title || 'this server'} first: Plugins → Connected → Sign in.`;
      auth = { Authorization: `Bearer ${token}` };
    } else if (server.auth === 'directory') {
      auth = directoryMcp.headersFor(server.id);
    } else if (server.auth === 'bearer') {
      auth = mcpStaticAuth(server);
      if (!auth) return `ERROR: ${name} needs ${server.tokenEnv}, which is not configured on this deployment.`;
    } else if (server.auth === 'internal') {
      auth = mcpInternalAuth(name);
      if (!auth) return `ERROR: ${name} needs a signed-in session and there is none.`;
    } else if (server.auth === 'nextcloud') {
      auth = mcpAuthHeaders();
      if (!auth) {
        // Actionable on purpose: the model relays this to the user, and the fix
        // is something only the user can do.
        return 'ERROR: this tool needs your Nextcloud account. Connect Nextcloud in Settings → Storage, then try again. (If it is already connected, the administrator has not listed its address in MCP_NEXTCLOUD_ORIGINS.)';
      }
    }

    if (server.directory && !(await directoryUrlAllowed(server.url))) return `ERROR: ${name} was not run: its server's address no longer resolves to a public host.`;
    try {
      const { session } = await mcp.connect(server.url, auth);
      let result;
      try {
        result = await mcp.callTool(server.url, session, name, args, auth);
      } finally {
        // Close it whatever happened. Nothing used to, so every tool call left a
        // session behind on the server for the life of the process.
        await mcp.disconnect(server.url, session, auth);
      }
      const text = mcp.resultToText(result);
      if (!text) return '(the tool returned no output)';
      // Was a blind `slice(0, cap)`. A listing from the Nextcloud box is an
      // array of near-identical objects, so most of what that slice spent the
      // budget on was the same keys over and over. Hoisting them to a header
      // row buys roughly twice the records for the same characters, and the
      // cap itself is unchanged. Nothing is dropped without saying so.
      const reduced = reduceToolResult(text, { maxChars: resultCap });
      if (reduced.reduced) logger.log(`[tool-result] ${name}: ${text.length} → ${reduced.text.length} chars`);
      return reduced.text;
    } catch (err) {
      // Returned, not thrown: a failed tool call is information the model can
      // act on or relay, and throwing would strand the chip with no result.
      return `ERROR calling ${name}: ${String((err && err.message) || err).slice(0, 300)}`;
    }
  }

  return {
    servers: MCP_SERVERS,
    enabled: () => MCP_ENABLED,
    state: mcpState,
    oauthServerIds, accountReady, probeMcpAuth, syncDirectoryServers,
    discoverOneServer, discoverMcpTools,
    mcpStaticAuth, mcpAuthHeaders, mcpInternalAuth, internalCallProjectId, mcpDiscoveryAuth,
    executeMcpToolCall,
  };
}

module.exports = { createMcpWiring, createDirectoryUrlAllowed, createCredentialOriginCheck, parseNextcloudOrigins };
