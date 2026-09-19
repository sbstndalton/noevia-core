'use strict';
// OAuth sign-in for MCP servers added from the directory (MCP authorization spec, 2025-06-18):
// protected-resource metadata (RFC 9728) → authorization-server metadata (RFC 8414) → dynamic
// client registration (RFC 7591) → authorization code with PKCE (RFC 7636) and a resource
// indicator (RFC 8707) → access and refresh tokens.
//
// Every sign-in belongs to ONE account (tenant isolation): a token is stored per (user, server),
// encrypted, and only ever attached to that user's calls to that server. Every URL taken from
// metadata comes from a stranger, so each one is checked (https, public address) before use.
const crypto = require('node:crypto');

const STATE_TTL_MS = 10 * 60 * 1000;
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fail = (message, status = 502) => Object.assign(new Error(message), { status });

function createMcpOAuth({ db, secrets, fetchImpl = globalThis.fetch, urlAllowed, redirectUri, now = () => Date.now(), audit = () => {} }) {
  db.exec(`CREATE TABLE IF NOT EXISTS mcp_oauth_clients(server_id TEXT PRIMARY KEY, data_enc TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS mcp_oauth_tokens(user_id TEXT NOT NULL, server_id TEXT NOT NULL, data_enc TEXT NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(user_id, server_id));`);
  const enc = (o) => secrets.encrypt(JSON.stringify(o));
  const dec = (s) => { try { return JSON.parse(secrets.decrypt(s)); } catch { return null; } };
  const pending = new Map(); // state -> { userId, serverId, verifier, expires, purpose }

  async function getJson(url, what) {
    if (!(await urlAllowed(url))) throw fail(`The ${what} address is not a public https address.`);
    const r = await fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': 'noevia' }, redirect: 'error', signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    return r.json().catch(() => null);
  }

  /** Find the authorization server for an MCP server; `challenge` is its WWW-Authenticate header, if any. */
  async function discover(serverUrl, challenge = '') {
    const u = new URL(serverUrl);
    const hinted = /resource_metadata="([^"]+)"/i.exec(String(challenge))?.[1];
    const candidates = [hinted, `${u.origin}/.well-known/oauth-protected-resource${u.pathname.replace(/\/$/, '')}`, `${u.origin}/.well-known/oauth-protected-resource`].filter(Boolean);
    let prm = null;
    for (const c of candidates) { prm = await getJson(c, 'resource metadata').catch(() => null); if (prm) break; }
    const issuer = Array.isArray(prm?.authorization_servers) ? prm.authorization_servers[0] : `${u.origin}`;
    if (typeof issuer !== 'string') throw fail('The server does not name a sign-in service.');
    const iu = new URL(issuer);
    const path = iu.pathname.replace(/\/$/, '');
    const asCandidates = [`${iu.origin}/.well-known/oauth-authorization-server${path}`, `${iu.origin}/.well-known/openid-configuration${path}`, `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`];
    let as = null;
    for (const c of asCandidates) { as = await getJson(c, 'sign-in service metadata').catch(() => null); if (as?.authorization_endpoint && as?.token_endpoint) break; as = null; }
    if (!as) throw fail('The server’s sign-in service did not describe itself (no OAuth metadata).');
    if (Array.isArray(as.code_challenge_methods_supported) && !as.code_challenge_methods_supported.includes('S256')) throw fail('The sign-in service does not support PKCE (S256).');
    for (const [k, v] of [['authorization', as.authorization_endpoint], ['token', as.token_endpoint], ['registration', as.registration_endpoint]]) {
      if (v && !(await urlAllowed(v))) throw fail(`The sign-in service’s ${k} address is not a public https address.`);
    }
    return { resource: serverUrl, issuer, authorizationEndpoint: as.authorization_endpoint, tokenEndpoint: as.token_endpoint,
      registrationEndpoint: as.registration_endpoint || null, scopes: Array.isArray(prm?.scopes_supported) ? prm.scopes_supported.filter((x) => typeof x === 'string').slice(0, 20) : [] };
  }

  /** Discover and register noevia once per server; kept (encrypted) for later sign-ins. */
  async function clientFor(serverId, serverUrl, challenge) {
    const row = db.prepare('SELECT data_enc FROM mcp_oauth_clients WHERE server_id=?').get(serverId);
    const known = row && dec(row.data_enc);
    if (known && known.redirectUri === redirectUri()) return known;
    const meta = await discover(serverUrl, challenge);
    if (!meta.registrationEndpoint) throw fail('The sign-in service does not allow apps to register themselves, so noevia cannot sign in to it yet.');
    const r = await fetchImpl(meta.registrationEndpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ client_name: 'noevia', redirect_uris: [redirectUri()], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }) });
    const reg = await r.json().catch(() => null);
    if (!r.ok || !reg?.client_id) throw fail(`The sign-in service refused to register noevia (${r.status}).`);
    const client = { ...meta, clientId: reg.client_id, clientSecret: reg.client_secret || null, redirectUri: redirectUri() };
    db.prepare('INSERT INTO mcp_oauth_clients VALUES(?,?,?) ON CONFLICT(server_id) DO UPDATE SET data_enc=excluded.data_enc, updated_at=excluded.updated_at').run(serverId, enc(client), now());
    return client;
  }

  /** The URL to send this user to; the state ties the answer to them and this server. */
  async function start({ userId, serverId, serverUrl, challenge = '', purpose = 'connect' }) {
    const client = await clientFor(serverId, serverUrl, challenge);
    for (const [k, v] of pending) if (v.expires < now()) pending.delete(k);
    const verifier = b64url(crypto.randomBytes(32));
    const state = b64url(crypto.randomBytes(24));
    pending.set(state, { userId, serverId, verifier, expires: now() + STATE_TTL_MS, purpose });
    const q = new URLSearchParams({ response_type: 'code', client_id: client.clientId, redirect_uri: client.redirectUri, state,
      code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', resource: client.resource });
    if (client.scopes.length) q.set('scope', client.scopes.join(' '));
    return `${client.authorizationEndpoint}${client.authorizationEndpoint.includes('?') ? '&' : '?'}${q}`;
  }

  async function tokenRequest(client, params) {
    const body = new URLSearchParams({ ...params, client_id: client.clientId, resource: client.resource });
    const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
    if (client.clientSecret) headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`).toString('base64')}`;
    const r = await fetchImpl(client.tokenEndpoint, { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(10000) });
    const t = await r.json().catch(() => null);
    if (!r.ok || !t?.access_token) throw fail(`The sign-in service did not issue a token (${r.status}${t?.error ? `: ${String(t.error).slice(0, 60)}` : ''}).`);
    return { accessToken: t.access_token, refreshToken: t.refresh_token || params.refresh_token || null,
      expiresAt: Number.isFinite(Number(t.expires_in)) ? now() + Number(t.expires_in) * 1000 : null };
  }

  /** The browser came back. Only the same signed-in user who started can finish. */
  async function finish({ userId, state, code }) {
    const p = pending.get(String(state || ''));
    if (!p || p.expires < now()) throw fail('This sign-in expired or was already used. Start again.', 400);
    pending.delete(state);
    if (p.userId !== userId) throw fail('This sign-in was started by a different account.', 403);
    const row = db.prepare('SELECT data_enc FROM mcp_oauth_clients WHERE server_id=?').get(p.serverId);
    const client = row && dec(row.data_enc);
    if (!client) throw fail('This server’s sign-in setup is missing. Start again.', 400);
    const tokens = await tokenRequest(client, { grant_type: 'authorization_code', code: String(code || ''), redirect_uri: client.redirectUri, code_verifier: p.verifier });
    db.prepare('INSERT INTO mcp_oauth_tokens VALUES(?,?,?,?) ON CONFLICT(user_id, server_id) DO UPDATE SET data_enc=excluded.data_enc, updated_at=excluded.updated_at').run(userId, p.serverId, enc(tokens), now());
    audit('mcp.oauth.connect', userId, { serverId: p.serverId });
    return { serverId: p.serverId, purpose: p.purpose };
  }

  /** A usable access token for this user and server, refreshed when close to expiry; null if none. */
  async function tokenFor(userId, serverId) {
    if (!userId) return null;
    const row = db.prepare('SELECT data_enc FROM mcp_oauth_tokens WHERE user_id=? AND server_id=?').get(userId, serverId);
    const t = row && dec(row.data_enc);
    if (!t) return null;
    if (!t.expiresAt || t.expiresAt - now() > 60000) return t.accessToken;
    if (!t.refreshToken) return null;
    const c = db.prepare('SELECT data_enc FROM mcp_oauth_clients WHERE server_id=?').get(serverId);
    const client = c && dec(c.data_enc);
    if (!client) return null;
    try {
      const next = await tokenRequest(client, { grant_type: 'refresh_token', refresh_token: t.refreshToken });
      db.prepare('UPDATE mcp_oauth_tokens SET data_enc=?, updated_at=? WHERE user_id=? AND server_id=?').run(enc(next), now(), userId, serverId);
      return next.accessToken;
    } catch { return null; }
  }

  const connected = (userId, serverId) => !!(userId && db.prepare('SELECT 1 FROM mcp_oauth_tokens WHERE user_id=? AND server_id=?').get(userId, serverId));
  function disconnect(userId, serverId) {
    db.prepare('DELETE FROM mcp_oauth_tokens WHERE user_id=? AND server_id=?').run(userId, serverId);
    audit('mcp.oauth.disconnect', userId, { serverId });
  }
  /** A removed server takes every account's sign-in and the registration with it. */
  function forget(serverId) {
    db.prepare('DELETE FROM mcp_oauth_tokens WHERE server_id=?').run(serverId);
    db.prepare('DELETE FROM mcp_oauth_clients WHERE server_id=?').run(serverId);
  }

  return { discover, start, finish, tokenFor, connected, disconnect, forget };
}

module.exports = { createMcpOAuth };
