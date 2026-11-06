'use strict';
// ── MCP wiring ────────────────────────────────────────────────────────────
// How noevia talks to MCP servers at runtime: the live server list (operator
// entries plus directory entries an administrator added), lazy cached
// discovery with per-server failure, which credential each server mode gets
// (a static bearer, a per-account key or sign-in, or a capability token for
// noevia's own internal server), and the client of the Rust front's executor
// that runs one discovered tool (sbstndalton/noevia#2218). The MCP protocol
// itself is mcp.cjs; the
// curated boxes are mcp-boxes.cjs; the directory and OAuth stores are
// injected, so this module holds no database and tests need no server.

const { createSecrets, scrubbedError, sanitizeTool } = require('./mcp-scrub.cjs');

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
 * @param {object} deps.directoryMcp     asServers, boxFor, headersFor, signal (the Rust front writes the table; this is a re-reader)
 * @param {object} deps.mcpOAuth         the OAuth broker (rust-mcp-credentials.cjs): connected, tokenFor, session, reject
 * @param {object} [deps.mcpKeys]        the keys broker: hasKey (sync, from its published readiness) and headers (async,
 *   one call's worth; never cached here). Without it no account has a key (fails closed).
 * @param {(url) => Promise<boolean>} deps.directoryUrlAllowed
 * @param {{ getStore() }} deps.scope    the request scope: { workspace:{userId}, authn:{user}, internalCallProject }
 * @param {(name) => boolean} deps.isWriteTool
 * @param {{ mintToken(key, claims) }} deps.internal   mcp-internal.cjs
 * @param {string|Buffer} deps.internalKey
 * @param {(request, { signal }) => Promise<{ ok, text?, status? }>} deps.mcpExec   the Rust front's tool executor (project-store-client.cjs mcpCall)
 * @param {NodeJS.ProcessEnv} [deps.env]   for a bearer server's tokenEnv
 * @param {(url, init) => Promise<Response>} [deps.fetch]
 * @param {(url, init) => Promise<Response>} [deps.publicFetch]   public-fetch.cjs: refuses a private
 *   address at connect time. Used for every request to a directory/custom server (the servers
 *   directoryUrlAllowed already requires to be public), so a name that re-resolves between that
 *   check and the request (DNS rebinding, #795) cannot reach the home network. The operator's
 *   MCP_SERVERS — a LAN Nextcloud server, noevia's own loopback server — never use it.
 * @param {number} [deps.discoveryTtlMs]
 * @param {number} [deps.discoveryFailTtlMs]   how long a failed/empty discovery is remembered
 *   before the next unforced request is allowed to retry every server again. Short on purpose:
 *   long enough that a member spamming GET /api/toolboxes cannot re-trigger a full
 *   connect/listTools/disconnect of every server on every request, short enough that a side-car
 *   coming back up is noticed soon. A forced discovery (admin add/remove, OAuth finish) always
 *   bypasses this.
 * @param {{ log, warn }} [deps.logger]
 */
function createMcpWiring({
  servers, manifest = [], mcp, bindBoxes, directoryMcp, mcpOAuth, mcpKeys = { hasKey: () => false, headers: async () => null }, directoryUrlAllowed,
  scope, isWriteTool, internal, internalKey,
  // Fails closed when nothing is wired: a call is refused, never run here.
  mcpExec = async () => ({ ok: false, status: 0 }),
  env = process.env, fetch = globalThis.fetch, publicFetch = null, discoveryTtlMs = 10 * 60 * 1000,
  discoveryFailTtlMs = Number(process.env.MCP_DISCOVERY_FAIL_TTL_MS || 30 * 1000), logger = console,
  isUserDisabled = () => false,
  // #1081: when a remote server failed discovery (its DNS or network may not be up yet at startup),
  // it is retried after these steps, one per consecutive failed discovery, instead of after the whole
  // discoveryTtlMs. The last step holds. Capped at discoveryTtlMs.
  discoveryRetryMs = [5000, 15000, 45000, 120000],
  // How often the Rust front's directory table is looked at on the hot paths (0: every time).
  directoryCheckMs = 250,
}) {
  const MCP_SERVERS = servers;
  if (publicFetch && typeof mcp.withFetch !== 'function') throw new TypeError('publicFetch needs an MCP client with withFetch');
  const publicMcp = publicFetch ? mcp.withFetch(publicFetch) : null;
  /** The transport for one server: a directory server's requests are pinned to public addresses. */
  const transportFor = (server) => (server && server.directory && publicMcp ? publicMcp : mcp);
  // Servers an administrator added from the public registry join the operator's list (after it,
  // so an operator's server keeps any tool name both offer). See directory-mcp.cjs.
  for (const sv of directoryMcp.asServers()) MCP_SERVERS.push(sv);
  const MCP_SERVER_BY_ID = new Map(MCP_SERVERS.map((sv) => [sv.id, sv]));
  let MCP_ENABLED = MCP_SERVERS.length > 0;

  const oauthServerIds = () => (refreshDirectory(), new Set(MCP_SERVERS.filter((sv) => sv.auth === 'oauth' || sv.auth === 'personal').map((sv) => sv.id)));
  /** Whether this account can use a per-account server: its own sign-in or its own key. */
  function accountReady(userId, serverId) {
    refreshDirectory();
    const sv = MCP_SERVERS.find((x) => x.id === serverId);
    if (!sv) return false;
    return sv.auth === 'oauth' ? mcpOAuth.connected(userId, serverId) : sv.auth === 'personal' ? mcpKeys.hasKey(userId, serverId) : true;
  }
  // The directory is the Rust front's table (sbstndalton/noevia#2202 round 2), re-read here: the list
  // this process works from is the one the table had when `directoryMcp.signal()` last said so. A table
  // that cannot be read has no servers (directory-mcp.cjs fails closed), so nothing stays offered from a
  // list that might be gone.
  let syncedWith;
  function syncDirectoryServers() {
    // The signal first: a write that lands while the list is read is caught by the next look.
    const seen = directoryMcp.signal();
    for (let i = MCP_SERVERS.length - 1; i >= 0; i--) if (MCP_SERVERS[i].directory) MCP_SERVERS.splice(i, 1);
    for (const sv of directoryMcp.asServers()) MCP_SERVERS.push(sv);
    MCP_SERVER_BY_ID.clear();
    for (const sv of MCP_SERVERS) MCP_SERVER_BY_ID.set(sv.id, sv);
    MCP_ENABLED = MCP_SERVERS.length > 0;
    syncedWith = seen;
  }
  /** Brings the server list up to date with the table; true when it had changed. The table is looked at
   *  at most once per `directoryCheckMs` (this is asked on every toolbox lookup of every turn). */
  let lookedAt = 0;
  function refreshDirectory(fresh = false) {
    const t = Date.now();
    if (!fresh && directoryCheckMs > 0 && t - lookedAt < directoryCheckMs && t >= lookedAt) return false;
    lookedAt = t;
    if (directoryMcp.signal() === syncedWith) return false;
    syncDirectoryServers();
    return true;
  }
  syncedWith = directoryMcp.signal();

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
  //
  // `tools` keeps one entry per name (the first server's) for status and the read/write hint.
  // It is NOT what a call is routed by: `offers` holds every server offering each name, and a
  // call goes to the server whose box offered the tool (#865) — or, when the caller cannot say
  // which server it means, is refused if more than one server offers that name.
  const mcpState = {
    tools: new Map(), // name -> { tool, readOnly, serverId }
    offers: new Map(), // name -> Map(serverId -> { tool, readOnly, serverId })
    boxes: [],
    servers: new Map(), // id -> { id, url, auth, error, discoveredAt, toolCount }
    discoveredAt: 0,
    // When the last discovery came back with no boxes at all (every server failed, or none
    // configured yet), the moment it finished — kept separately from discoveredAt so the
    // internal-server-down retry-sooner behaviour below cannot also defeat the failure TTL.
    failedAt: 0,
    // #1081: consecutive discoveries in which a remote server failed (reset when every server answers).
    remoteFailStreak: 0,
    error: null,
    inflight: null,
  };

  /** A server's own service token, if it was configured with one. Distinct from
   *  the USER's Nextcloud credential (the front's, mcp_exec.rs) — this is a
   *  single key belonging to noevia's deployment, identical for everyone. */
  function mcpStaticAuth(server) {
    if (!server || server.auth !== 'bearer' || !server.tokenEnv) return null;
    const token = env[server.tokenEnv];
    return token ? { Authorization: `Bearer ${token}` } : null;
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
    // The approved edit target (#648), set by the chat loop for this call chain only.
    const target = scope.getStore()?.internalEditTarget;
    const token = internal.mintToken(internalKey, {
      uid: workspace.userId,
      pid: internalCallProjectId(),
      w: isWriteTool(name) ? 1 : 0,
      ...(isWriteTool(name) && typeof target === 'string' && target ? { t: target } : {}),
    });
    return { Authorization: `Bearer ${token}` };
  }

  /** Discovery runs with no user in scope, so it gets a token that can list the
   *  catalogue and can never call anything. The catalogue is static and
   *  identical for everyone, so this leaks nothing. Longer-lived than a call
   *  token because listTools paginates, and harmless because it cannot act. */
  function mcpDiscoveryAuth(server) {
    if (server && server.auth === 'directory') return directoryMcp.headersFor(server.id);
    if (server && server.auth === 'internal') {
      return { Authorization: `Bearer ${internal.mintToken(internalKey, { discovery: true, ttlMs: 120000 })}` };
    }
    return mcpStaticAuth(server);
  }

  async function discoverOneServer(server) {
    // Discovery lists the catalogue only. A per-USER credential is attached at
    // call time instead (the front's executor), but a static service token has to
    // be present here or the server has nothing to list.
    // A directory server is someone else's: re-check at every discovery that its name still points
    // at a public address, so a DNS change cannot turn it into a probe of the home network.
    if (server.directory && !(await directoryUrlAllowed(server.url))) throw new Error('its address no longer resolves to a public host');
    let headers = mcpDiscoveryAuth(server);
    if (server.auth === 'personal') {
      // The tool list is read with the key of the administrator who added the server. A disabled
      // administrator's key is not trusted for discovery, even if it is still stored.
      if (server.addedBy && isUserDisabled(server.addedBy)) throw new Error('waiting for an active administrator to add a key');
      headers = await mcpKeys.headers(server.addedBy, server.id);
      if (!headers || !Object.keys(headers).length) throw new Error('waiting for the administrator who added it to enter their key');
    }
    if (server.auth === 'oauth') {
      // The tool list is read with the sign-in of the administrator who added the server. A
      // disabled administrator's sign-in is not trusted for discovery, even if it is still stored.
      if (server.addedBy && isUserDisabled(server.addedBy)) throw new Error('waiting for an active administrator to sign in');
      const token = await mcpOAuth.tokenFor(server.addedBy, server.id);
      if (!token) throw new Error('waiting for the administrator who added it to sign in');
      headers = { Authorization: `Bearer ${token}` };
    }
    const transport = transportFor(server);
    // Everything this server says comes back through one scrub with the headers actually sent (#2218 review): a failure's
    // message (an HTTP body, a JSON-RPC message or code) reaches the log, mcpState.servers, the catalogue the Rust front
    // reads and the admin directory; a tool's name and description reach the same catalogue and the toolbox picker.
    const secrets = createSecrets(headers);
    let discovered;
    try {
      const { session } = await transport.connect(server.url, headers);
      try {
        discovered = await transport.listTools(server.url, session, headers);
      } finally {
        await transport.disconnect(server.url, session, headers);
      }
    } catch (err) {
      throw scrubbedError(err, secrets);
    }
    const byName = new Map();
    const dropped = [];
    for (const listed of discovered) {
      // The whole definition, before anything is stored or converted: the name, the description and every nested
      // descriptive string of the schema are scrubbed, and a tool whose contract itself repeats a credential is dropped.
      const clean = sanitizeTool(listed, secrets);
      if (clean.dropped) { dropped.push(`${secrets.scrub(String((listed && listed.name) || '(unnamed)'))}: ${clean.dropped}`); continue; }
      const t = clean.tool;
      const conv = mcp.convertTool(t);
      if (!conv.ok) { dropped.push(secrets.scrub(`${(t && t.name) || '(unnamed)'}: ${conv.reason}`)); continue; }
      byName.set(conv.tool.function.name, { tool: conv.tool, readOnly: mcp.readOnlyHint(t), serverId: server.id });
    }
    if (dropped.length) logger.warn(`[mcp:${server.id}] dropped ${dropped.length} unconvertible tools: ${dropped.join(' | ')}`);
    return byName;
  }

  // Whether the administrator who added each per-account server is ready for it (their sign-in or key,
  // which discovery reads the tool list with). The Rust front completes the sign-in callback and stores
  // keys, so this process is not the one to call a forced discovery when they change: it notices here.
  const credentialKey = () => MCP_SERVERS
    .filter((sv) => sv.auth === 'oauth' || sv.auth === 'personal')
    .map((sv) => `${sv.id}:${sv.auth === 'oauth' ? !!mcpOAuth.connected(sv.addedBy, sv.id) : !!mcpKeys.hasKey(sv.addedBy, sv.id)}`)
    .join('|');
  let discoveredWith;
  async function discoverMcpTools(force = false) {
    // The Rust front adds, re-keys and removes directory servers: a changed table is rediscovered now.
    if (refreshDirectory(true)) force = true;
    // A credential discovery depends on changed since the last discovery: the tool list it was waiting
    // for (or must no longer offer) is read again now, as a forced discovery after the sign-in was.
    const credentials = credentialKey();
    if (!force && discoveredWith !== undefined && credentials !== discoveredWith) force = true;
    // No servers left (the last directory server was just removed): nothing may stay offered.
    if (!MCP_ENABLED) { mcpState.tools = new Map(); mcpState.offers = new Map(); mcpState.boxes = []; mcpState.servers = new Map(); mcpState.error = null; return mcpState; }
    const fresh = Date.now() - mcpState.discoveredAt < discoveryTtlMs;
    if (!force && fresh && mcpState.boxes.length) return mcpState;
    // A discovery that found nothing (every server failed, or none are configured yet) is still
    // worth remembering for a short TTL: otherwise every unauthenticated poll of
    // GET /api/toolboxes re-triggers a full connect/listTools/disconnect of every server. Forced
    // discovery (admin add/remove, OAuth finish) always bypasses this — it must see the outcome
    // of the change it just made, not a stale failure from before it.
    const recentFailure = !mcpState.boxes.length && Date.now() - mcpState.failedAt < discoveryFailTtlMs;
    if (!force && recentFailure) return mcpState;
    // A forced refresh (a server was just added or removed) must not reuse a discovery that
    // started before the change: wait for it, then discover again with the new list.
    if (mcpState.inflight && force) { await mcpState.inflight.catch(() => undefined); return discoverMcpTools(true); }
    if (mcpState.inflight) return mcpState.inflight;
    mcpState.inflight = (async () => {
      discoveredWith = credentials;
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
        // first in `tools` — declaration order in MCP_SERVERS is the tie-break, and the
        // collision is logged rather than silently resolved. `offers` keeps every server
        // offering the name, which is what a call is routed by (the front's executor, from the `offers` a call carries).
        const byName = new Map();
        const offers = new Map();
        for (const server of MCP_SERVERS) {
          for (const [name, entry] of perServer.get(server.id) || []) {
            if (!offers.has(name)) offers.set(name, new Map());
            offers.get(name).set(server.id, entry);
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
        mcpState.offers = offers;
        mcpState.boxes = boxes;
        mcpState.servers = found;
        // The internal server is this process. If it did not answer, something
        // is starting up or broken here, not on a remote host that needs ten
        // minutes of backoff — retry on the next request instead of hiding its
        // boxes for the whole TTL.
        const internalDown = [...found.values()].some((sv) => sv.auth === 'internal' && sv.error);
        // #1081: a remote server that failed (fetch failed at startup, before DNS was up) is retried on a
        // short backoff rather than hidden for the whole TTL. Discovery still runs lazily on the next request.
        const remoteDown = [...found.values()].some((sv) => sv.auth !== 'internal' && sv.error);
        mcpState.remoteFailStreak = remoteDown ? mcpState.remoteFailStreak + 1 : 0;
        const retryMs = remoteDown && discoveryRetryMs.length
          ? Math.min(discoveryTtlMs, discoveryRetryMs[Math.min(mcpState.remoteFailStreak, discoveryRetryMs.length) - 1])
          : discoveryTtlMs;
        // discoveredAt is set so the next unforced request is fresh for exactly `retryMs`.
        mcpState.discoveredAt = internalDown ? 0 : Date.now() - (discoveryTtlMs - retryMs);
        // A run that produced no boxes at all (every server failed, including the case above, or
        // none are configured) is remembered for the short failure TTL regardless — an internal
        // server that keeps failing must not turn into an unthrottled retry loop either.
        mcpState.failedAt = boxes.length ? 0 : Date.now();
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

  /** Runs one discovered tool (sbstndalton/noevia#2218): the Rust front's executor does it (noevia-rs bins/noevia-server
   *  mcp_exec.rs): routing by (server, name), the approved-edit binding, the account's own credential, the 429 wait, the
   *  MCP session, the one retry after a refused sign-in and the reduction of the result. This is its client, and it fails
   *  closed: a front that cannot be asked or does not answer is a refused call, never one this process runs itself.
   *
   *  Discovery stays here, so the call carries what only this process knows: which servers offer the name (`offers`),
   *  whether the chat approved it as a project-file edit, the account (`caller`: its key and sign-in; `workspace`: its
   *  Nextcloud connection) and, for noevia's own server, the capability token this process alone can mint.
   *  Like the executor it replaced, it RETURNS a failure as text: a thrown error would strand the chip with no result. */
  async function executeMcpToolCall(name, args, signal, serverId) {
    refreshDirectory();
    const store = scope.getStore();
    const offered = mcpState.offers.get(name);
    const offers = offered ? [...offered.keys()] : [];
    // The token is minted only when an internal server could take the call; the front uses it only if its own routing
    // resolves to one. 30 seconds, bound to this user and project by the HMAC.
    const internalAuth = offers.some((id) => MCP_SERVER_BY_ID.get(id)?.auth === 'internal') ? mcpInternalAuth(name)?.Authorization : undefined;
    const request = {
      name, args, offers,
      ...(serverId !== undefined && serverId !== null ? { server: serverId } : {}),
      ...(store?.authn?.user?.id ? { caller: store.authn.user.id } : {}),
      ...(store?.workspace?.userId ? { workspace: store.workspace.userId } : {}),
      ...(store?.internalEditTarget ? { editTarget: true } : {}),
      ...(internalAuth ? { internalAuth } : {}),
    };
    let answer;
    try { answer = await mcpExec(request, { signal }); } catch (err) {
      if ((signal && signal.aborted) || (err && err.name === 'AbortError')) return `ERROR calling ${name}: This operation was aborted`;
      logger.warn(`[mcp] ${name} not run: the tool executor could not be asked (${String((err && err.code) || (err && err.name) || 'error').slice(0, 60)})`);
      return `ERROR calling ${name}: tool execution is unavailable right now. Try again in a moment.`;
    }
    if (!answer || answer.ok !== true) {
      logger.warn(`[mcp] ${name} not run: the tool executor answered ${answer && answer.status}`);
      return `ERROR calling ${name}: tool execution is unavailable right now. Try again in a moment.`;
    }
    return answer.text;
  }

  return {
    servers: MCP_SERVERS,
    enabled: () => MCP_ENABLED,
    state: mcpState,
    oauthServerIds, accountReady, syncDirectoryServers, refreshDirectory,
    discoverOneServer, discoverMcpTools,
    mcpStaticAuth, mcpInternalAuth, internalCallProjectId, mcpDiscoveryAuth,
    executeMcpToolCall,
  };
}

module.exports = { createMcpWiring, createDirectoryUrlAllowed, createCredentialOriginCheck, parseNextcloudOrigins };
