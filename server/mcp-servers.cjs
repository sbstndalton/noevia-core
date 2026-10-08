'use strict';

// Parsing of the MCP server list (`MCP_SERVERS` / `MCP_SERVER_URL`) and the curated-box
// filter (`ENABLED_TOOLBOXES`). Pure functions of the environment they are handed, so the
// credential pass-through rules are testable without booting the server.
//
// MCP_SERVERS_IMPL=js|wasm (default js; any other value means js, with one warning), read from the
// environment handed in (createToolboxOffered: process.env, when it is created): wasm decides the
// server list, the box filter and toolboxOffered in noevia-rs's mcp-servers crate (in
// dav-parse.wasm). The token variables' values never cross; this file prints the warnings. Fails
// closed: the flag is in dav-parse-wasm.cjs IMPL_FLAGS (a missing or tampered module stops
// startup); a fault or an unexpected reply configures no MCP server, offers no curated box but
// core and dir-* (ENABLED_TOOLBOXES as an empty set), and a toolboxOffered fault answers false.
// Every server the port returns is checked again here (http(s), no credentials, internal only on a
// loopback IP literal and at most once, ids unique and well-formed, the URL from the environment).
// Stricter than the JS: a list where the Rust and V8 URL parsers could disagree configures nothing
// (see the crate docs).

// An MCP server URL is the same class of thing as a member-supplied provider
// or storage endpoint, so it reuses the existing policy rather than inventing
// a third. It is admin/deployment configuration (an env var, not something a
// member can set), which under endpointApproved() is exactly the admin case —
// pointing at a private address such as another container is legitimate and
// expected. The guard that matters here is the shape check: http/https only,
// and no credentials smuggled into the URL.
// One or more MCP servers.
//
// MCP_SERVERS is a comma-separated list of `id|url|auth` entries; auth is
// either `nextcloud` (forward the user's Nextcloud app password, subject to
// the origin allowlist below) or `none`. MCP_SERVER_URL remains supported and
// means exactly what it always did: a single Nextcloud MCP server.
//
// auth is per server and not optional-by-default for a reason. The credential
// pass-through hands a user's Nextcloud password to the server being called.
// That is correct for the Nextcloud MCP and a credential leak for anything
// else, so a server gets it only when the operator says so by name.
// `internal` names noevia's own in-process MCP server. It is accepted only for
// a loopback IP LITERAL: a DNS name — including `localhost` — can be made to
// resolve somewhere else, and this listener answers to a capability token
// rather than a session cookie, so pointing it off-box would hand that
// capability to a stranger. No rebinding, no surprises.
function isLoopbackLiteral(hostname) {
  const h = String(hostname || '').replace(/^\[|\]$/g, '');
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) {
    return h.split('.').every((part) => Number(part) >= 0 && Number(part) <= 255);
  }
  return h === '::1' || h === '0:0:0:0:0:0:0:1';
}

/** shapeOk as the JS applies it; `warn` receives the warning (a no-op when re-checking a reply). */
function shapeOkWith(warn) {
  return (raw, label) => {
    try {
      const u = new URL(raw);
      if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) {
        warn(`[mcp] ignoring ${label}: must be http(s) with no embedded credentials`);
        return false;
      }
      return true;
    } catch {
      warn(`[mcp] ignoring ${label}: not a valid URL`);
      return false;
    }
  };
}

/** The MCP_SERVERS walk of parseMcpServersJs: the servers it configures, in order. `warn` gets each
 *  warning; the reply check passes a no-op and compares what the port returned against this. */
function walkMcpServers(list, env, warn) {
  const shapeOk = shapeOkWith(warn);
  const out = [];
  const seen = new Set();
  for (const entry of list.split(',').map((e) => e.trim()).filter(Boolean)) {
    const [rawId, rawUrl, rawAuth] = entry.split('|').map((x) => (x || '').trim());
    const id = (rawId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
    if (!id || !rawUrl) { warn(`[mcp] ignoring malformed MCP_SERVERS entry "${entry}"`); continue; }
    if (seen.has(id)) { warn(`[mcp] ignoring duplicate MCP server id "${id}"`); continue; }
    if (!shapeOk(rawUrl, `MCP server "${id}"`)) continue;
    // `bearer:ENV_NAME` reads a static token from that environment variable.
    // The name, not the value, goes in the config: a key belongs in its own
    // variable, never in a URL that gets logged, and never inline here where
    // it would be printed by anything that echoes the server list.
    let auth = 'none';
    let tokenEnv = null;
    if (rawAuth === 'internal') {
      // Dropped rather than downgraded on any doubt. Silently demoting this
      // to `none` would leave a server configured and unusable; leaving it
      // out makes its two boxes disappear, which is the documented
      // unconfigured state and is at least honest.
      let host = '';
      try { host = new URL(rawUrl).hostname; } catch { host = ''; }
      if (!isLoopbackLiteral(host)) {
        warn(`[mcp] ignoring internal server "${id}": ${host || 'that host'} is not a loopback IP literal. Use 127.0.0.1, not a name.`);
        continue;
      }
      if (out.some((sv) => sv.auth === 'internal')) {
        warn(`[mcp] ignoring internal server "${id}": there is only one in-process server and it is already configured`);
        continue;
      }
      auth = 'internal';
    } else if (rawAuth === 'nextcloud') {
      auth = 'nextcloud';
    } else if (rawAuth && rawAuth.startsWith('bearer:')) {
      const envName = rawAuth.slice('bearer:'.length).trim();
      if (!/^[A-Z0-9_]+$/.test(envName)) {
        warn(`[mcp] server "${id}": bearer needs an environment variable name, got "${envName}" — treating as none`);
      } else if (!env[envName]) {
        warn(`[mcp] server "${id}": ${envName} is not set, so its tools will not authenticate`);
        auth = 'bearer';
        tokenEnv = envName;
      } else {
        auth = 'bearer';
        tokenEnv = envName;
      }
    } else if (rawAuth && rawAuth !== 'none') {
      warn(`[mcp] server "${id}": unknown auth "${rawAuth}", treating as none`);
    }
    seen.add(id);
    out.push({ id, url: rawUrl, auth, ...(tokenEnv ? { tokenEnv } : {}) });
  }
  return out;
}

function parseMcpServersJs(env = process.env) {
  const shapeOk = shapeOkWith((m) => console.warn(m));
  const list = (env.MCP_SERVERS || '').trim();
  if (list) return walkMcpServers(list, env, (m) => console.warn(m));

  const single = (env.MCP_SERVER_URL || '').trim();
  if (!single) return [];
  if (!shapeOk(single, 'MCP_SERVER_URL')) return [];
  // The historical single-server deployment is the Nextcloud MCP, and it has
  // always received the credential — keep that exactly.
  return [{ id: 'nextcloud', url: single, auth: 'nextcloud' }];
}

// Which curated boxes are actually offered. Curation says what a box WOULD
// contain; this says whether anyone wants it. Unset means all of them.
//
// Separate from the manifest on purpose: a deployment that has no use for
// Cookbook should not have to delete its curation to stop seeing it, and
// turning it back on should be one environment variable rather than a commit.
function parseEnabledToolboxesJs(env = process.env) {
  const raw = (env.ENABLED_TOOLBOXES || '').trim();
  if (!raw) return null; // null means "no opinion" — offer everything
  const ids = raw.split(',').map((x) => x.trim()).filter(Boolean);
  return ids.length ? new Set(ids) : null;
}

function createToolboxOfferedJs(ENABLED_TOOLBOXES) {
  return function toolboxOffered(id) {
  // core is built-in and always safe, so it is never filtered out — a
  // deployment that named only MCP boxes should not lose the clock.
  if (id === 'core') return true;
  // An administrator adding a directory server is the opt-in; ENABLED_TOOLBOXES curates the operator's boxes.
  if (id.startsWith('dir-')) return true;
  return !ENABLED_TOOLBOXES || ENABLED_TOOLBOXES.has(id);
  };
}

const IMPLS = new Set(['js', 'wasm']);
let warnedImpl = '';
/** MCP_SERVERS_IMPL: 'js' (default) or 'wasm'. */
function mcpServersImpl(env = process.env) {
  const raw = env.MCP_SERVERS_IMPL;
  if (raw === undefined || raw === '') return 'js';
  const value = String(raw).trim().toLowerCase();
  if (IMPLS.has(value)) return value;
  if (warnedImpl !== value) {
    warnedImpl = value;
    console.warn(`[mcp] MCP_SERVERS_IMPL=${JSON.stringify(String(raw))} is not js or wasm; using js`);
  }
  return 'js';
}
let warnedFault = '';
function warnFault(err) {
  const reason = String(err?.reason || 'unexpected');
  if (warnedFault !== reason) { warnedFault = reason; console.warn(`[mcp] the Rust port failed (${reason}); failing closed`); }
}
const defaultLoader = () => require('./dav-parse-wasm.cjs');
const fault = (message, reason = 'reply') => Object.assign(new Error(message), { reason });

/** An environment value as the JS reads it (`v || ''`), crossed as a string or null. */
function envText(v) {
  const s = v || '';
  if (typeof s !== 'string') throw fault('environment value is not a string', 'input');
  return s || null;
}

const ID_RE = /^[a-zA-Z0-9_-]{1,40}$/;
const TOKEN_ENV_RE = /^[A-Z0-9_]+$/;
const AUTHS = new Set(['none', 'nextcloud', 'internal', 'bearer']);

/** What the port returned, held to the JS's own rules again: never more than the JS accepts. */
function checkServers(servers, list, single) {
  // Each returned server must be an operator entry, auth and token variable included: the port may
  // drop a server but never invent one, move a URL to another id, or change its credentials.
  const expected = list ? new Map(walkMcpServers(list.trim(), {}, () => {}).map((sv) => [sv.id, sv])) : null;
  const ids = new Set();
  let internal = 0;
  return servers.map((sv) => {
    if (!ID_RE.test(sv.id) || ids.has(sv.id) || typeof sv.url !== 'string' || !AUTHS.has(sv.auth)) throw fault('mcp server reply has an unexpected server');
    ids.add(sv.id);
    if (list) {
      // The port may drop a server, never substitute one: each must be the JS's own for that id.
      const e = expected.get(sv.id);
      if (!e || e.url !== sv.url || e.auth !== sv.auth || (e.tokenEnv ?? null) !== (sv.auth === 'bearer' ? sv.tokenEnv : null)) throw fault('mcp server reply has a server not in the environment');
    } else if (sv.id !== 'nextcloud' || sv.auth !== 'nextcloud' || sv.url !== single.trim()) throw fault('mcp server reply has a server not in the environment');
    let u;
    try { u = new URL(sv.url); } catch { throw fault('mcp server reply has an invalid URL'); }
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw fault('mcp server reply has a refused URL');
    if (sv.auth === 'internal' && (!isLoopbackLiteral(u.hostname) || ++internal > 1)) throw fault('mcp server reply has a refused internal server');
    if ((sv.auth === 'bearer') !== Object.hasOwn(sv, 'tokenEnv') || (sv.auth === 'bearer' && !TOKEN_ENV_RE.test(sv.tokenEnv))) throw fault('mcp server reply has an unexpected token');
    return { id: sv.id, url: sv.url, auth: sv.auth, ...(sv.auth === 'bearer' ? { tokenEnv: sv.tokenEnv } : {}) };
  });
}

function parseMcpServersWasm(env, wasmLoader) {
  try {
    const list = envText(env.MCP_SERVERS);
    const single = envText(env.MCP_SERVER_URL);
    const { servers, warnings } = wasmLoader().mcpServersParse(list, single);
    const out = checkServers(servers, list && list.trim() ? list : null, single);
    for (const w of warnings) {
      if (typeof w === 'string') console.warn(w);
      else if (!env[w.bearer]) console.warn(`[mcp] server "${w.id}": ${w.bearer} is not set, so its tools will not authenticate`);
    }
    return out;
  } catch (err) {
    warnFault(err);
    return [];
  }
}

/** The MCP server list. `opts.wasmLoader` is for tests. */
function parseMcpServers(env = process.env, { wasmLoader = defaultLoader } = {}) {
  return mcpServersImpl(env) === 'wasm' ? parseMcpServersWasm(env, wasmLoader) : parseMcpServersJs(env);
}

/** The curated-box filter; on a fault an empty set (only core and dir-* boxes are offered). */
function parseEnabledToolboxes(env = process.env, { wasmLoader = defaultLoader } = {}) {
  if (mcpServersImpl(env) !== 'wasm') return parseEnabledToolboxesJs(env);
  try {
    const ids = wasmLoader().mcpToolboxes(envText(env.ENABLED_TOOLBOXES));
    return ids === null ? null : new Set(ids);
  } catch (err) {
    warnFault(err);
    return new Set();
  }
}

/** toolboxOffered over `ENABLED_TOOLBOXES`; `opts.impl` pins 'js' or 'wasm' (tests), default
 *  MCP_SERVERS_IMPL when created. core and dir-* are always offered; otherwise through the port a
 *  fault (or an id that is not a string) is false. */
function createToolboxOffered(ENABLED_TOOLBOXES, { impl, wasmLoader = defaultLoader } = {}) {
  if ((impl || mcpServersImpl()) !== 'wasm') return createToolboxOfferedJs(ENABLED_TOOLBOXES);
  let enabled;
  let setupFault = false;
  try {
    if (!ENABLED_TOOLBOXES) enabled = null;
    else if (ENABLED_TOOLBOXES instanceof Set && [...ENABLED_TOOLBOXES].every((x) => typeof x === 'string')) enabled = [...ENABLED_TOOLBOXES];
    else throw fault('ENABLED_TOOLBOXES is not a set of strings', 'input');
  } catch (err) {
    warnFault(err);
    setupFault = true;
  }
  return function toolboxOffered(id) {
    // core and dir-* are offered exactly as the JS offers them, before the port is asked: no fault
    // there (setup or per id) can take them away.
    if (id === 'core') return true;
    if (typeof id === 'string' && id.startsWith('dir-')) return true;
    if (setupFault) return false;
    try {
      if (typeof id !== 'string') throw fault('toolbox id is not a string', 'input');
      return wasmLoader().mcpToolboxOffered(enabled, id);
    } catch (err) {
      warnFault(err);
      return false;
    }
  };
}

module.exports = { isLoopbackLiteral, parseMcpServers, parseEnabledToolboxes, createToolboxOffered, parseMcpServersJs, parseEnabledToolboxesJs, createToolboxOfferedJs, mcpServersImpl };
