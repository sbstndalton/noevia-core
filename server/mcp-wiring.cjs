'use strict';
// ── MCP wiring ────────────────────────────────────────────────────────────
// How noevia talks to MCP servers at runtime: the live server list (operator
// entries plus directory entries an administrator added), which credential
// each server mode gets at call time (nextcloud pass-through, a static bearer,
// a per-account key or sign-in, or a capability token for noevia's own internal
// server), and the executor that runs one discovered tool. The MCP protocol
// itself is mcp.cjs; the directory and OAuth stores are injected, so this
// module holds no database and tests need no server.
//
// DISCOVERY IS THE RUST FRONT'S (sbstndalton/noevia row T, mcp_discovery_actor.rs): connecting to
// every server, listing and converting its tools, binding the curated boxes, the refresh cadence,
// failure backoff and the coalescing of callers. This module is a fail-closed client of it
// (`discovery.discover`, over the internal store): what comes back replaces `mcpState`
// wholesale, under a generation that never goes backwards, and a front that cannot answer leaves
// NO tools and no boxes, never the last list.

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
 * @param {object} deps.mcp              the protocol client for executing a tool: connect, callTool, disconnect, resultToText
 * @param {{ discover(opts: { force?: boolean, generation?: number|null }): Promise<object> }} deps.discovery
 *   the Rust front's discovery (mcp-native-discovery.cjs): the snapshot, or `{ unchanged: true }`; it throws when the front cannot answer
 * @param {object} deps.directoryMcp     asServers, boxFor, headersFor, signal (the Rust front writes the table; this is a re-reader)
 * @param {object} deps.mcpOAuth         the OAuth broker (rust-mcp-credentials.cjs): connected, tokenFor, session, reject
 * @param {object} [deps.mcpKeys]        the keys broker: hasKey (sync, from its published readiness) and headers (async,
 *   one call's worth; never cached here). Without it no account has a key (fails closed).
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
 * @param {(url, init) => Promise<Response>} [deps.publicFetch]   public-fetch.cjs: refuses a private
 *   address at connect time. Used for every request to a directory/custom server (the servers
 *   directoryUrlAllowed already requires to be public), so a name that re-resolves between that
 *   check and the request (DNS rebinding, #795) cannot reach the home network. The operator's
 *   MCP_SERVERS — a LAN Nextcloud server, noevia's own loopback server — never use it.
 * @param {{ log, warn }} [deps.logger]
 * @param {{ enabled(): boolean, call(payload, opts: { signal }): Promise<{ status, body }> }} [deps.nativeCalls]
 *   track R5: the Rust front's tool call (`POST /v1/mcp/call`, noevia-rs mcp_call.rs). While `enabled()`
 *   (NOEVIA_RUST_MCP_CALLS=1), a routed call is the front's: the credential, the transport, the back-off and
 *   the text are decided there, and this process keeps the routing and the result reducer.
 */
function createMcpWiring({
  servers, mcp, discovery, directoryMcp, mcpOAuth, mcpKeys = { hasKey: () => false, headers: async () => null }, directoryUrlAllowed, credentialOriginAllowed,
  scope, storageFor, isWriteTool, internal, internalKey, reduceToolResult, resultCap = 8000,
  env = process.env, fetch = globalThis.fetch, publicFetch = null, logger = console,
  toolRateLimit = require('./tool-rate-limit.cjs').createToolRateLimit(),
  // How often the Rust front's directory table is looked at on the hot paths (0: every time).
  directoryCheckMs = 250,
  nativeCalls = null,
}) {
  const rateLimit = require('./tool-rate-limit.cjs');
  const REFRESH_ASK_MS = 5000;
  const PER_USER_AUTH = new Set(['nextcloud', 'personal', 'oauth']);
  /** An access token for one call: the broker's session ({ accessToken, generation }), or null. */
  const oauthSessionFor = async (userId, serverId, rejected = null, signal = undefined) => {
    if (typeof mcpOAuth.session === 'function') return mcpOAuth.session(userId, serverId, rejected, { signal });
    const token = await mcpOAuth.tokenFor(userId, serverId, { signal });
    return token ? { accessToken: token, generation: '' } : null;
  };
  /** What a tool call says when its credential could not be fetched for a reason that is NOT "the account has to
   *  sign in": the broker is down or busy (`transient`) - nothing is wrong with the sign-in or key, so the
   *  person is not sent to redo it - or the chat was stopped. */
  const credentialTrouble = (name, server, err) => {
    if (err && err.name === 'AbortError') return `ERROR calling ${name}: the request was stopped.`;
    if (err && err.transient === true) return `ERROR: ${name} could not check your ${server.auth === 'oauth' ? 'sign-in' : 'key'} for ${server.title || 'this server'} right now. This is temporary: try again in a moment. Do not sign in again.`;
    // Anything else is returned like any other failed call (a thrown error would strand the chip with no result).
    return `ERROR calling ${name}: ${String((err && err.message) || err).slice(0, 300)}`;
  };
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

  // ── Discovery: the Rust front's (mcp_discovery_actor.rs), read here ──────────────────────────────
  //
  // `tools` maps a tool name to the server that offers it, because a call has to be routed back to
  // the right one - and because a box may only bind tools from the server it declares, so a second
  // server cannot quietly take over a curated box by offering a tool of the same name.
  //
  // `tools` keeps one entry per name (the first server's) for status and the read/write hint.
  // It is NOT what a call is routed by: `offers` holds every server offering each name, and a
  // call goes to the server whose box offered the tool (#865) - or, when the caller cannot say
  // which server it means, is refused if more than one server offers that name.
  /** Nothing is offered: no tool, no box, no server status. What the state is when the front cannot say. */
  function clearState(error) {
    mcpState.tools = new Map(); mcpState.offers = new Map(); mcpState.boxes = []; mcpState.servers = new Map(); mcpState.error = error;
    mcpState.discoveredAt = 0; mcpState.failedAt = 0; mcpState.remoteFailStreak = 0;
  }
  /** The front's snapshot as `mcpState`. Servers keep the order the front reports (the order they finished). */
  function applySnapshot(snap) {
    const servers = new Map();
    for (const sv of snap.servers) servers.set(sv.id, { ...sv });
    const offers = new Map();
    const byName = new Map();
    for (const o of snap.offers) {
      const entry = { tool: o.tool, readOnly: o.readOnly === true || o.readOnly === false ? o.readOnly : null, serverId: o.server };
      if (!offers.has(o.name)) offers.set(o.name, new Map());
      offers.get(o.name).set(o.server, entry);
      if (!byName.has(o.name)) byName.set(o.name, entry);
    }
    mcpState.tools = byName;
    mcpState.offers = offers;
    mcpState.boxes = snap.boxes;
    mcpState.servers = servers;
    mcpState.error = typeof snap.error === 'string' ? snap.error : null;
    mcpState.discoveredAt = snap.discoveredAt;
    mcpState.failedAt = snap.failedAt;
    mcpState.remoteFailStreak = snap.remoteFailStreak;
  }
  const mcpState = {
    tools: new Map(), // name -> { tool, readOnly, serverId }
    offers: new Map(), // name -> Map(serverId -> { tool, readOnly, serverId })
    boxes: [],
    servers: new Map(), // id -> { id, url, auth, error, discoveredAt, toolCount }
    discoveredAt: 0,
    failedAt: 0,
    remoteFailStreak: 0,
    error: null,
    /** The front's generation this state is of (never goes backwards), or null while it holds none. */
    generation: null,
    incarnation: null,
  };
  let applying = Promise.resolve();
  let requestEpoch = 0;
  let highWater = -1;
  let frontIncarnation = null;
  let askedAt = 0;
  let refreshing = null;
  /** A look at the toolboxes asks the front whether discovery moved, in the background and at most every few
   *  seconds: the front refreshes on its own cadence, but only when asked, and nothing else here asks. */
  function refreshSoon() {
    if (refreshing || Date.now() - askedAt < REFRESH_ASK_MS) return;
    askedAt = Date.now();
    refreshing = discoverMcpTools().catch(() => undefined).finally(() => { refreshing = null; });
  }
  /**
   * Asks the front what it has discovered (it refreshes on its own cadence; `force` rediscovers now).
   * Never throws: a front that cannot answer leaves nothing offered, with `error` saying so, and the
   * next call asks again. An answer older than the state already held is dropped (calls overlap).
   */
  async function discoverMcpTools(force = false) {
    // The server list the executor works from follows the directory table; a changed table is
    // rediscovered now.
    if (refreshDirectory(true)) force = true;
    const epoch = ++requestEpoch;
    const held = mcpState.generation;
    const incarnation = mcpState.incarnation;
    let snap;
    try {
      snap = await discovery.discover({ force, generation: held, incarnation });
    } catch {
      applying = applying.then(() => {
        if (epoch !== requestEpoch) return;
        clearState('MCP tool discovery is unavailable right now.');
        mcpState.generation = null;
        mcpState.incarnation = null;
      });
      await applying;
      logger.warn('[mcp] discovery unavailable');
      return mcpState;
    }
    applying = applying.then(() => {
      if (epoch !== requestEpoch) return;
      if (snap.unchanged === true) {
        if (held !== null && snap.generation === held && snap.incarnation === incarnation
            && mcpState.generation === held && mcpState.incarnation === incarnation) return;
        clearState('MCP tool discovery is unavailable right now.');
        mcpState.generation = null; mcpState.incarnation = null;
        return;
      }
      if (snap.incarnation === frontIncarnation && snap.generation < highWater) return;
      if (!MCP_ENABLED && snap.enabled) return;
      if (snap.incarnation !== frontIncarnation) highWater = -1;
      frontIncarnation = snap.incarnation;
      highWater = Math.max(highWater, snap.generation);
      applySnapshot(snap);
      mcpState.generation = snap.generation;
      mcpState.incarnation = snap.incarnation;
    });
    await applying;
    return mcpState;
  }

  /** Which server's tool a call means (#865). A call is routed by (server, name): `serverId` is
   *  the server whose box offered the tool to the model. Without one, a name only one server
   *  offers is unambiguous; a name two servers offer is refused rather than guessed, because
   *  guessing sends the call — and that server's credential — somewhere the model was not shown. */
  function routeMcpTool(name, serverId) {
    const offered = mcpState.offers.get(name);
    if (serverId !== undefined && serverId !== null) {
      const entry = offered ? offered.get(serverId) : null;
      return entry ? { known: entry } : { error: `ERROR: unknown tool "${name}" on MCP server "${serverId}"` };
    }
    if (offered && offered.size > 1) {
      logger.warn(`[mcp] refused a call to "${name}" without a server: offered by ${[...offered.keys()].map((id) => `"${id}"`).join(', ')}`);
      return { error: `ERROR: tool "${name}" is offered by more than one MCP server, so it was not run.` };
    }
    const known = mcpState.tools.get(name);
    return known ? { known } : { error: `ERROR: unknown tool "${name}"` };
  }

  /** The one operator (non-directory) server offering a name, for noevia's own fixed callers
   *  (deep research's tavily_search / tavily_extract). They name a tool the operator configured,
   *  so a directory server offering the same name must neither take the call nor make it
   *  ambiguous. `undefined` when no operator server, or more than one, offers it. */
  function operatorServerFor(name) {
    const offered = mcpState.offers.get(name);
    if (!offered) return undefined;
    const ids = [...offered.keys()].filter((id) => { const sv = MCP_SERVER_BY_ID.get(id); return sv && !sv.directory; });
    return ids.length === 1 ? ids[0] : undefined;
  }

  /** Run a fixed caller's tool (deep research's tavily_search / tavily_extract) on the one
   *  operator server offering it. With no such server the call fails and nothing is sent: falling
   *  back to name routing would hand the query, with that server's credential, to a directory
   *  server (#891). Chat tool calls keep using executeMcpToolCall. */
  async function executeOperatorToolCall(name, args, signal) {
    const serverId = operatorServerFor(name);
    if (serverId === undefined) {
      logger.warn(`[mcp] refused "${name}" for a fixed caller: no single operator MCP server offers it`);
      const message = 'Web search is not configured on this server.';
      throw Object.assign(Error(message), { publicMessage: message });
    }
    return executeMcpToolCall(name, args, signal, serverId);
  }

  async function executeMcpToolCall(name, args, signal, serverId) {
    refreshDirectory();
    const route = routeMcpTool(name, serverId);
    if (route.error) return route.error;
    const known = route.known;
    const server = MCP_SERVER_BY_ID.get(known.serverId);
    if (!server) return `ERROR: tool "${name}" belongs to MCP server "${known.serverId}", which is no longer configured`;
    if (nativeCalls && !nativeOff && nativeCalls.enabled()) {
      const answer = await executeNativeToolCall(name, args, signal, server);
      if (answer !== NOT_NATIVE) return answer;
    }
    // An approval for a project file edit names a stored project file, and only noevia's own
    // server edits project files. A call carrying that approval that is routed anywhere else was
    // approved for something it would not do: refused, nothing sent (#865 review).
    if (scope.getStore()?.internalEditTarget && server.auth !== 'internal') {
      logger.warn(`[mcp] refused "${name}": approved as a project file edit but routed to MCP server "${server.id}"`);
      return `ERROR: ${name} was approved as a project file edit, but "${name}" was offered by MCP server "${server.id}"; it was not run.`;
    }

    // Credentials are per server. Forwarding the user's Nextcloud password to a
    // server that merely happens to be configured would hand their password to
    // somebody else's service, so only a server the operator marked
    // auth=nextcloud gets it — and then only if the origin allowlist agrees.
    let auth = null;
    // The signed-in account's sign-in session, kept to retry once if the server refuses its token.
    let oauthSession = null;
    const callerId = scope.getStore()?.authn?.user?.id;
    if (server.auth === 'personal') {
      // Each account's own key, never another's: asked of the broker for this call only.
      // `signal` is the chat's: Stop cancels the broker call too.
      try { auth = await mcpKeys.headers(callerId, server.id, { signal }); } catch (e) { return credentialTrouble(name, server, e); }
      if (!auth || !Object.keys(auth).length) return `ERROR: ${name} needs your own key for ${server.title || 'this server'}: Plugins → Connected → Add key.`;
    } else if (server.auth === 'oauth') {
      // Each account's own sign-in, never another's: an access token for this call only. The refresh
      // token stays with the broker. A broker that cannot say right now is "try again", not "sign in".
      try { oauthSession = await oauthSessionFor(callerId, server.id, null, signal); } catch (e) { return credentialTrouble(name, server, e); }
      if (!oauthSession) return `ERROR: ${name} needs you to sign in to ${server.title || 'this server'} first: Plugins → Connected → Sign in.`;
      auth = { Authorization: `Bearer ${oauthSession.accessToken}` };
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
    // #1693: a provider that answered 429 is not called again inside its wait. Per server, and per account for every
    // server that sends the account's own credentials (#1701: nextcloud too), so one account never pauses another.
    const rateKey = `${server.id}\u0000${PER_USER_AUTH.has(server.auth) ? String(scope.getStore()?.authn?.user?.id || '') : ''}`;
    const coolingMs = toolRateLimit.remaining(rateKey);
    if (coolingMs > 0) return rateLimit.coolingDownText(name, coolingMs);
    try {
      const transport = transportFor(server);
      const callOnce = async (headers) => {
        const { session } = await transport.connect(server.url, headers, undefined, signal);
        try {
          return await transport.callTool(server.url, session, name, args, headers, undefined, signal);
        } finally {
          // Close it whatever happened. Nothing used to, so every tool call left a
          // session behind on the server for the life of the process.
          await transport.disconnect(server.url, session, headers, undefined, signal);
        }
      };
      let result;
      try {
        result = await callOnce(auth);
      } catch (err) {
        // A server that refuses the token it was just given: ask the broker for one past it (it
        // refreshes only if that token is still the stored one) and try once more. A second refusal
        // marks THAT sign-in as needing a new one, so the account is told to sign in again.
        if (!(oauthSession && err && err.httpStatus === 401)) throw err;
        let next;
        try { next = await oauthSessionFor(callerId, server.id, oauthSession.accessToken, signal); }
        catch (down) {
          // The broker could not say (down, or its refresh at the service failed just now). The 401
          // stands as the answer, and NOTHING is marked: the sign-in may be perfectly good, and
          // marking it would cost the account a sign-in over a passing fault.
          if (signal && signal.aborted) throw down;
          throw err;
        }
        // No usable sign-in left: the broker has already marked the refused one (it does that itself when
        // it cannot refresh past it), so there is nothing to mark here either.
        if (!next) throw err;
        if (next.accessToken === oauthSession.accessToken) {
          // The broker's best is the very token that was refused: that sign-in is no good.
          if (typeof mcpOAuth.reject === 'function') await mcpOAuth.reject(callerId, server.id, oauthSession.generation).catch(() => false);
          throw err;
        }
        oauthSession = next;
        try { result = await callOnce({ Authorization: `Bearer ${next.accessToken}` }); }
        catch (again) {
          if (again && again.httpStatus === 401 && typeof mcpOAuth.reject === 'function') await mcpOAuth.reject(callerId, server.id, next.generation).catch(() => false);
          throw again;
        }
      }
      const text = mcp.resultToText(result);
      if (result && result.isError && rateLimit.isRateLimitedText(text)) {
        logger.warn(`[mcp] ${name} rate limited (tool error)`);
        return rateLimit.rateLimitedText(name, toolRateLimit.hit(rateKey));
      }
      if (!result || !result.isError) toolRateLimit.clear(rateKey);
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
      // An HTTP failure carries the server's response body in its message; that
      // is third-party text, so it goes to the log and the model gets a
      // neutral line with the status only.
      if (err && err.httpStatus === 429) {
        logger.warn(`[mcp] ${name} rate limited (HTTP 429)`);
        return rateLimit.rateLimitedText(name, toolRateLimit.hit(rateKey, rateLimit.parseRetryAfter(err.retryAfter)));
      }
      if (err && Number.isInteger(err.httpStatus)) {
        logger.warn(`[mcp] ${name} failed: ${String(err.message).slice(0, 300)}`);
        return `ERROR calling ${name}: tool call failed (HTTP ${err.httpStatus})`;
      }
      return `ERROR calling ${name}: ${String((err && err.message) || err).slice(0, 300)}`;
    }
  }

  /** What a front that runs no tool calls answers (an older front, or its switch off): this process
   *  runs the call itself, as before. Nothing has been sent anywhere when the front says so. */
  const NOT_NATIVE = Symbol('not native');
  /** The front was not reached, or refused before doing anything: trying again is safe. */
  const NATIVE_UNAVAILABLE = 'MCP tools are unavailable right now. Try again in a moment.';
  /** The front may have sent the call and then failed to report: a write may have happened. */
  const NATIVE_UNKNOWN = 'the tool call did not report back, so it may or may not have run. Check before calling it again.';
  let nativeOff = false;
  const text = (v) => (v === null || v === undefined ? null : String(v));
  /** One routed call, run by the Rust front (track R5). The scope's facts travel with it; the Nextcloud
   *  pass-through is the one credential this process supplies (it holds the storage connection), and only
   *  where core's own order would have read it (after the project-file-edit refusal). */
  async function executeNativeToolCall(name, args, signal, server) {
    const store = scope.getStore();
    const editTarget = typeof store?.internalEditTarget === 'string' ? store.internalEditTarget : null;
    const workspace = store && store.workspace;
    const passThrough = server.auth === 'nextcloud' && !editTarget ? mcpAuthHeaders() : null;
    const payload = {
      server: server.id,
      name,
      arguments: args ?? {},
      user: text(store?.authn?.user?.id),
      workspaceUser: workspace ? String(workspace.userId ?? '') : null,
      project: internalCallProjectId(),
      editTarget,
      write: !!isWriteTool(name),
      nextcloud: passThrough ? Object.fromEntries(Object.entries(passThrough).map(([k, v]) => [k, String(v)])) : null,
    };
    const stopped = () => `ERROR calling ${name}: This operation was aborted`;
    let answer;
    try {
      answer = await nativeCalls.call(payload, { signal });
    } catch (err) {
      if ((err && err.name === 'AbortError') || (signal && signal.aborted)) return stopped();
      // The store's deadline passed: the front may have sent the call (core's own timeout said this).
      if (err && err.cause && err.cause.name === 'TimeoutError') return stopped();
      logger.warn(`[mcp] ${name}: the front's tool call could not be asked (${err && err.code ? err.code : 'error'})`);
      return `ERROR calling ${name}: ${NATIVE_UNAVAILABLE}`;
    }
    if (answer && answer.status === 404) {
      if (!nativeOff) logger.warn('[mcp] NOEVIA_RUST_MCP_CALLS is on here, but the front runs no tool calls: this process runs them');
      nativeOff = true;
      return NOT_NATIVE;
    }
    if (signal && signal.aborted) return stopped();
    // Refused before anything was sent (a body it would not take, or no clients): safe to retry.
    if (answer && (answer.status === 400 || answer.status === 503)) {
      logger.warn(`[mcp] ${name}: the front's tool call answered ${answer.status}`);
      return `ERROR calling ${name}: ${NATIVE_UNAVAILABLE}`;
    }
    const body = answer && answer.status === 200 ? answer.body : null;
    if (!body || typeof body.text !== 'string' || typeof body.reduce !== 'boolean') {
      logger.warn(`[mcp] ${name}: the front's tool call answered ${answer ? answer.status : 'nothing'}`);
      return `ERROR calling ${name}: ${NATIVE_UNKNOWN}`;
    }
    if (!body.reduce) return body.text;
    const reduced = reduceToolResult(body.text, { maxChars: resultCap });
    if (reduced.reduced) logger.log(`[tool-result] ${name}: ${body.text.length} → ${reduced.text.length} chars`);
    return reduced.text;
  }

  return {
    servers: MCP_SERVERS,
    enabled: () => MCP_ENABLED,
    state: mcpState,
    oauthServerIds, accountReady, syncDirectoryServers, refreshDirectory,
    discoverMcpTools, refreshSoon,
    mcpStaticAuth, mcpAuthHeaders, mcpInternalAuth, internalCallProjectId,
    executeMcpToolCall, operatorServerFor, executeOperatorToolCall,
  };
}

module.exports = { createMcpWiring, createDirectoryUrlAllowed, createCredentialOriginCheck, parseNextcloudOrigins };
