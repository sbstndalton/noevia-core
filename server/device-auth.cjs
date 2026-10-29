'use strict';
// Sign-in for native (non-browser) clients, issue #555: the OAuth 2.0 Device Authorization Grant
// (RFC 8628). The flow itself (POST /api/auth/device/code and /token, the browser's lookup and
// approval, the device list and its revocation) is the Rust front's (noevia-rs crates/server-account,
// permanent since sbstndalton/noevia#1071); it writes the device tables. What stays here:
//
//   - the tables' schema (ensureDeviceSchema, run by auth.cjs at boot);
//   - authenticate: a request's device access token, read-only (the front touches the grant's
//     last_used_at before it proxies, server-auth upkeep);
//   - device-off cleanup and issuance are native-only (no Node revoke API), formerly wired
//     in index.cjs);
//   - createRequestAuth and BROWSER_ONLY, the router's single credential check.
//
// A request with a device access token acts as the same account, but never as an administrator
// (the effective role is `member`), and never on the account-security routes listed in
// BROWSER_ONLY. Those need a signed-in browser. See docs/api-browser-core-v1.md, "Native clients".

const crypto = require('node:crypto');

const ACCESS_PREFIX = 'nva_';

// Paths a device token can never use, whatever the method: the account's security settings,
// credentials that mint more credentials, and administration. Prefix match on a segment
// boundary. Administration is also refused by the member role; it is listed as well so the
// refusal says why.
const BROWSER_ONLY = Object.freeze([
  '/api/admin',
  '/api/auth/passkeys',
  '/api/auth/sessions',
  '/api/auth/devices',
  '/api/auth/device/lookup',
  '/api/auth/device/approve',
  '/api/profile/app-passwords',
  '/api/profile/diary-connectors',
  '/api/profile/sharing',
  '/api/integrations/storage/nextcloud',
  '/api/mcp-keys',
  '/api/mcp-oauth',
  '/api/providers/chatgpt',
]);
// Exact paths refused to a device token: GET /api/profile lists sessions and passkeys, and the
// storage connection (PUT) and its test (POST) carry storage credentials. Reading and writing
// files through the connection stays allowed.
const BROWSER_ONLY_EXACT = Object.freeze(new Set(['/api/profile']));
const BROWSER_ONLY_WRITES = Object.freeze(new Set(['/api/integrations/storage', '/api/integrations/storage/test']));
// Every write under these prefixes: linking or unlinking a connector account (Google Drive) and
// its per-tool allow/ask/block policy (Drive, Nextcloud). A stolen token could otherwise link the
// thief's Drive or pre-allow tools, which would outlive the token's revocation (review F2).
const BROWSER_ONLY_WRITE_PREFIXES = Object.freeze(['/api/connectors/']);

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/**
 * @param {object} deps
 * @param {import('better-sqlite3').Database} deps.db       the auth database (auth.cjs)
 * @param {(row:object) => object} deps.publicUser          auth.cjs publicUser
 * @param {() => number} [deps.now]
 */
function createDeviceAuth({ db, publicUser, now = Date.now }) {
  ensureDeviceSchema(db);
  const q = {
    userRow: db.prepare('SELECT * FROM users WHERE id=?'),
    tokenRow: db.prepare(`SELECT t.token_hash, t.kind, t.expires_at AS token_expires_at, g.id AS grant_id, g.user_id,
        g.client_name, g.expires_at AS grant_expires_at
      FROM device_tokens t JOIN device_grants g ON g.id=t.grant_id WHERE t.token_hash=?`),
  };

  /**
   * The request's device identity, or null. Only an `Authorization: Bearer nva_…` header counts.
   * The effective role is always `member`; `accountRole` keeps the stored one for callers that
   * need the account's own workspace (never for permission checks). Read-only.
   */
  function authenticate(req) {
    const raw = bearerToken(req);
    if (!raw) return null;
    const at = now();
    const row = q.tokenRow.get(digest(raw));
    if (!row || row.kind !== 'access' || row.token_expires_at <= at || row.grant_expires_at <= at) return null;
    const user = q.userRow.get(row.user_id);
    if (!user || user.disabled_at) return null;
    const account = publicUser(user);
    return {
      user: { ...account, role: 'member' }, session: null, legacy: false, accountRole: account.role,
      device: { id: row.grant_id, clientName: row.client_name, expiresAt: row.grant_expires_at },
    };
  }

  return { authenticate };
}

/** The bearer value when it is a device access token, else ''. Never reads a query string. */
function bearerToken(req) {
  const header = String(req.headers?.authorization || '');
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match && match[1].startsWith(ACCESS_PREFIX) ? match[1] : '';
}

function hasSessionCookie(req) {
  return String(req.headers?.cookie || '').split(';').some((part) => {
    const name = part.split('=')[0].trim();
    return name === 'cowork_session' || name === 'cowork_csrf';
  });
}

function browserOnly(pathname, method = 'GET') {
  const p = String(pathname || '');
  if (BROWSER_ONLY_EXACT.has(p)) return true;
  const write = !['GET', 'HEAD'].includes(String(method).toUpperCase());
  if (write && (BROWSER_ONLY_WRITES.has(p) || BROWSER_ONLY_WRITE_PREFIXES.some((prefix) => p.startsWith(prefix)))) return true;
  return BROWSER_ONLY.some((prefix) => p === prefix || p.startsWith(`${prefix}/`));
}

/** Creates the tables. Called by auth.cjs so they exist whether or not the feature is on. */
function ensureDeviceSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS device_authorizations(
      device_code_hash TEXT PRIMARY KEY, user_code_hash TEXT NOT NULL UNIQUE,
      client_name TEXT NOT NULL, ip TEXT NOT NULL, user_agent TEXT NOT NULL,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, interval_ms INTEGER NOT NULL,
      last_poll_at INTEGER, status TEXT NOT NULL CHECK(status IN ('pending','approved','denied')),
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE, decided_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS device_authorizations_expires_idx ON device_authorizations(expires_at);
    CREATE TABLE IF NOT EXISTS device_grants(
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      client_name TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, ip TEXT NOT NULL, user_agent TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS device_grants_user_idx ON device_grants(user_id);
    CREATE TABLE IF NOT EXISTS device_tokens(
      token_hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES device_grants(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('access','refresh')), created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, used_at INTEGER, replaced_by TEXT
    );
    CREATE INDEX IF NOT EXISTS device_tokens_grant_idx ON device_tokens(grant_id);
  `);
  // replaced_by: the hash of the refresh token that succeeded this one (review F3). Guarded for
  // databases created by an earlier build of this branch.
  if (!db.prepare('PRAGMA table_info(device_tokens)').all().some((c) => c.name === 'replaced_by')) {
    db.exec('ALTER TABLE device_tokens ADD COLUMN replaced_by TEXT');
  }
}

/**
 * The router's view of a request's credential (index.cjs). With the feature off this is exactly
 * auth.cjs: cookie sessions and the legacy bearer, unchanged. With it on, a device bearer token
 * (`nva_…`) is authenticated here and never falls back to a cookie; a request carrying both is
 * unauthenticated (the open mount answers it with 400 first).
 */
function createRequestAuth({ enabled, deviceAuth, authService }) {
  return {
    authenticate(req) {
      if (bearerToken(req) && enabled()) return hasSessionCookie(req) ? null : deviceAuth.authenticate(req);
      return authService.authenticate(req);
    },
    /** A device token is not an ambient credential, so CSRF does not apply; a cookie never rides along. */
    csrfValid(req, authn) {
      if (authn?.device) return !hasSessionCookie(req);
      return authService.csrfValid(req, authn);
    },
    /** True when `authn` is a device token and the route needs a signed-in browser. */
    browserOnly(authn, pathname, method) {
      return !!authn?.device && browserOnly(pathname, method);
    },
  };
}

module.exports = { createDeviceAuth, createRequestAuth, ensureDeviceSchema, browserOnly, bearerToken, hasSessionCookie, ACCESS_PREFIX, BROWSER_ONLY };
