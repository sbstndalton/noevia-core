'use strict';

// Parsing of the MCP server list (`MCP_SERVERS` / `MCP_SERVER_URL`) and the curated-box
// filter (`ENABLED_TOOLBOXES`). Pure functions of the environment they are handed, so the
// credential pass-through rules are testable without booting the server.

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

function parseMcpServers(env = process.env) {
  const shapeOk = (raw, label) => {
    try {
      const u = new URL(raw);
      if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) {
        console.warn(`[mcp] ignoring ${label}: must be http(s) with no embedded credentials`);
        return false;
      }
      return true;
    } catch {
      console.warn(`[mcp] ignoring ${label}: not a valid URL`);
      return false;
    }
  };

  const list = (env.MCP_SERVERS || '').trim();
  if (list) {
    const out = [];
    const seen = new Set();
    for (const entry of list.split(',').map((e) => e.trim()).filter(Boolean)) {
      const [rawId, rawUrl, rawAuth] = entry.split('|').map((x) => (x || '').trim());
      const id = (rawId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
      if (!id || !rawUrl) { console.warn(`[mcp] ignoring malformed MCP_SERVERS entry "${entry}"`); continue; }
      if (seen.has(id)) { console.warn(`[mcp] ignoring duplicate MCP server id "${id}"`); continue; }
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
          console.warn(`[mcp] ignoring internal server "${id}": ${host || 'that host'} is not a loopback IP literal. Use 127.0.0.1, not a name.`);
          continue;
        }
        if (out.some((sv) => sv.auth === 'internal')) {
          console.warn(`[mcp] ignoring internal server "${id}": there is only one in-process server and it is already configured`);
          continue;
        }
        auth = 'internal';
      } else if (rawAuth === 'nextcloud') {
        auth = 'nextcloud';
      } else if (rawAuth && rawAuth.startsWith('bearer:')) {
        const envName = rawAuth.slice('bearer:'.length).trim();
        if (!/^[A-Z0-9_]+$/.test(envName)) {
          console.warn(`[mcp] server "${id}": bearer needs an environment variable name, got "${envName}" — treating as none`);
        } else if (!env[envName]) {
          console.warn(`[mcp] server "${id}": ${envName} is not set, so its tools will not authenticate`);
          auth = 'bearer';
          tokenEnv = envName;
        } else {
          auth = 'bearer';
          tokenEnv = envName;
        }
      } else if (rawAuth && rawAuth !== 'none') {
        console.warn(`[mcp] server "${id}": unknown auth "${rawAuth}", treating as none`);
      }
      seen.add(id);
      out.push({ id, url: rawUrl, auth, ...(tokenEnv ? { tokenEnv } : {}) });
    }
    return out;
  }

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
function parseEnabledToolboxes(env = process.env) {
  const raw = (env.ENABLED_TOOLBOXES || '').trim();
  if (!raw) return null; // null means "no opinion" — offer everything
  const ids = raw.split(',').map((x) => x.trim()).filter(Boolean);
  return ids.length ? new Set(ids) : null;
}

function createToolboxOffered(ENABLED_TOOLBOXES) {
  return function toolboxOffered(id) {
  // core is built-in and always safe, so it is never filtered out — a
  // deployment that named only MCP boxes should not lose the clock.
  if (id === 'core') return true;
  // An administrator adding a directory server is the opt-in; ENABLED_TOOLBOXES curates the operator's boxes.
  if (id.startsWith('dir-')) return true;
  return !ENABLED_TOOLBOXES || ENABLED_TOOLBOXES.has(id);
  };
}

module.exports = { isLoopbackLiteral, parseMcpServers, parseEnabledToolboxes, createToolboxOffered };
