'use strict';
// Sign-in for native (non-browser) clients, issue #555. The flow is the OAuth 2.0 Device
// Authorization Grant (RFC 8628):
//
//   1. The app calls POST /api/auth/device/code with its display name. It gets a device_code,
//      which it keeps secret, and a short user_code, which it shows to the person.
//   2. The person opens /device in a browser where they are already signed in, compares the code,
//      and approves or denies. Approval needs a real browser session plus CSRF, never a token.
//   3. The app polls POST /api/auth/device/token. After approval it receives an access token and a
//      refresh token for its own grant: one row per device, listed and revocable in Settings.
//
// Tokens are 256-bit random values. Only their SHA-256 is stored. An access token lasts an hour.
// A refresh token rotates on every use, and a refresh token presented twice revokes the whole
// grant (reuse detection, per the OAuth 2.0 Security BCP), except for a retry within 60 s while
// its successor is still unused (REFRESH_GRACE_MS). The grant itself lives as long as a browser
// session: 7 idle days and 30 days in total (auth.cjs IDLE_MS/ABSOLUTE_MS). Switching the feature
// off deletes every grant (revokeAll, wired in index.cjs).
//
// A request with a device access token acts as the same account, but never as an administrator
// (the effective role is `member`), and never on the account-security routes listed in
// BROWSER_ONLY. Those need a signed-in browser. See docs/api-browser-core-v1.md, "Native clients".

const crypto = require('node:crypto');

const DEVICE_CODE_TTL_MS = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 5 * 1000;
const SLOW_DOWN_STEP_MS = 5 * 1000;
const ACCESS_TTL_MS = 60 * 60 * 1000;
const REFRESH_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
const GRANT_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_PENDING = 1024;
const CLIENT_NAME_MAX = 60;
// RFC 8628 §6.1: no vowels (no accidental words) and no easily confused characters.
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
const USER_CODE_LENGTH = 8;
const ACCESS_PREFIX = 'nva_';
const REFRESH_PREFIX = 'nvr_';
const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

// How long the refresh token just replaced stays usable, while its successor is unused: a client
// whose refresh answer was lost in transit retries with the old one (#555 review F3).
const REFRESH_GRACE_MS = 60 * 1000;

// Rate limits (fixed windows from auth.cjs createRateLimiter). Behind the Cloudflare tunnel with
// TRUST_PROXY off every request shares one socket address, so nothing that a stranger can fill
// is keyed on the address alone (#555 review F1). Token requests are charged to the credential
// they present; an unknown credential goes to its own bucket and never touches a real device's.
// Malformed requests are refused before any bucket is charged.
const WINDOW = 15 * 60 * 1000;
const LIMITS = Object.freeze({
  codeName: { limit: 10, windowMs: WINDOW },       // POST /device/code per client name
  codeAddress: { limit: 10, windowMs: WINDOW },    //   ...and per address, only when TRUST_PROXY makes it real
  codeGlobal: { limit: 200, windowMs: WINDOW },    //   ...and a backstop for the whole server
  tokenCredential: { limit: 150, windowMs: WINDOW }, // POST /device/token per presented device code or refresh token
  tokenUnknown: { limit: 300, windowMs: WINDOW },  //   unknown credentials: one bucket (per address when trusted)
  // Backstop for device-code polls only (review N1). Refreshes never touch it: a refresh token
  // cannot be minted without an approval and already has its own 150. Each device code counts
  // toward it for its first 20 polls only, so the at most 200 codes a window allows (20 × 200 =
  // 4,000) cannot fill it, and polls that are only slow_down/authorization_pending stop counting.
  tokenGlobal: { limit: 5000, windowMs: WINDOW },
  tokenGlobalShare: { limit: 20, windowMs: WINDOW },
  // Refreshes per grant (review R1). Each refresh mints a new token with a fresh per-credential
  // budget, so without this one approved device could rotate in a loop without limit.
  tokenGrant: { limit: 30, windowMs: WINDOW },
  verify: { limit: 20, windowMs: WINDOW },         // lookups + decisions per signed-in account
});

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

function randomSecret(prefix = '') {
  return prefix + crypto.randomBytes(32).toString('base64url');
}

function randomUserCode() {
  // Rejection sampling keeps every character equally likely.
  const out = [];
  while (out.length < USER_CODE_LENGTH) {
    for (const byte of crypto.randomBytes(16)) {
      if (byte >= 240) continue; // 240 = 12 * 20
      out.push(USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length]);
      if (out.length === USER_CODE_LENGTH) break;
    }
  }
  return out.join('');
}

/** `bcdf ghjk`, `BCDF-GHJK` -> `BCDFGHJK`; anything that cannot be a code -> ''. */
function normalizeUserCode(raw) {
  const value = String(raw || '').toUpperCase().replace(/[\s-]/g, '');
  if (value.length !== USER_CODE_LENGTH) return '';
  for (const ch of value) if (!USER_CODE_ALPHABET.includes(ch)) return '';
  return value;
}

function formatUserCode(code) {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** A display name chosen by the (untrusted) app: printable, single-line, bounded. */
function cleanClientName(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\p{C}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, CLIENT_NAME_MAX).trim();
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

const oauthError = (error, description, status = 400) => ({ status, body: { error, error_description: description } });

/**
 * @param {object} deps
 * @param {import('better-sqlite3').Database} deps.db       the auth database (auth.cjs)
 * @param {(action:string, actor:string|null, target:string|null, detail?:object) => void} deps.audit
 * @param {(row:object) => object} deps.publicUser          auth.cjs publicUser
 * @param {{ rateLimited: (key:string, limit:number, windowMs:number) => boolean }} deps.rate
 * @param {(req:object) => string} deps.clientAddress
 * @param {() => string} deps.origin                         the public origin, for verification_uri
 * @param {() => number} [deps.now]
 * @param {boolean} [deps.addressesTrusted]  TRUST_PROXY: only then is a client address a real,
 *        per-client value worth showing or rate limiting on. Off, it is the tunnel's address.
 */
function createDeviceAuth({ db, audit, publicUser, rate, clientAddress, origin, now = Date.now, addressesTrusted = false }) {
  ensureDeviceSchema(db);
  const q = {
    sweep: db.prepare('DELETE FROM device_authorizations WHERE expires_at<=?'),
    pending: db.prepare("SELECT count(*) AS n FROM device_authorizations WHERE status='pending'"),
    insertAuthorization: db.prepare(`INSERT INTO device_authorizations(device_code_hash,user_code_hash,client_name,ip,user_agent,created_at,expires_at,interval_ms,status)
      VALUES(?,?,?,?,?,?,?,?,'pending')`),
    byDeviceCode: db.prepare('SELECT * FROM device_authorizations WHERE device_code_hash=?'),
    byUserCode: db.prepare('SELECT * FROM device_authorizations WHERE user_code_hash=?'),
    deleteAuthorization: db.prepare('DELETE FROM device_authorizations WHERE device_code_hash=?'),
    poll: db.prepare('UPDATE device_authorizations SET last_poll_at=?, interval_ms=? WHERE device_code_hash=?'),
    decide: db.prepare("UPDATE device_authorizations SET status=?, user_id=?, decided_at=? WHERE device_code_hash=? AND status='pending' AND expires_at>?"),
    userRow: db.prepare('SELECT * FROM users WHERE id=?'),
    insertGrant: db.prepare('INSERT INTO device_grants(id,user_id,client_name,created_at,last_used_at,expires_at,ip,user_agent) VALUES(?,?,?,?,?,?,?,?)'),
    insertToken: db.prepare('INSERT INTO device_tokens(token_hash,grant_id,kind,created_at,expires_at) VALUES(?,?,?,?,?)'),
    tokenRow: db.prepare(`SELECT t.token_hash, t.kind, t.expires_at AS token_expires_at, t.used_at, t.replaced_by, g.id AS grant_id, g.user_id,
        g.client_name, g.expires_at AS grant_expires_at, g.last_used_at
      FROM device_tokens t JOIN device_grants g ON g.id=t.grant_id WHERE t.token_hash=?`),
    tokenState: db.prepare('SELECT used_at FROM device_tokens WHERE token_hash=?'),
    markUsed: db.prepare('UPDATE device_tokens SET used_at=?, replaced_by=? WHERE token_hash=? AND used_at IS NULL'),
    setReplacedBy: db.prepare('UPDATE device_tokens SET replaced_by=? WHERE token_hash=?'),
    // A discarded successor stays in the table, marked used with no successor of its own, so
    // presenting it later is reuse and revokes the grant (review N2). Only if still unused.
    discard: db.prepare('UPDATE device_tokens SET used_at=?, replaced_by=NULL WHERE token_hash=? AND used_at IS NULL'),
    // R1: used links older than the grace window are dropped, except the latest one (the token
    // being rotated now), which is what reuse detection of the previous token needs. Discarded
    // successors (used, replaced_by NULL) are kept for the grant's life: presenting one is how a
    // thief who replayed inside the window is caught (N2). They only arise from audited grace uses.
    prune: db.prepare(`DELETE FROM device_tokens WHERE grant_id=? AND kind='refresh' AND used_at IS NOT NULL
      AND replaced_by IS NOT NULL AND used_at<=? AND token_hash<>?`),
    grantsByUser: db.prepare('SELECT user_id, count(*) AS n FROM device_grants GROUP BY user_id'),
    deleteAllGrants: db.prepare('DELETE FROM device_grants'),
    deleteAllAuthorizations: db.prepare('DELETE FROM device_authorizations'),
    dropAccess: db.prepare("DELETE FROM device_tokens WHERE grant_id=? AND kind='access'"),
    touchGrant: db.prepare('UPDATE device_grants SET last_used_at=? WHERE id=?'),
    deleteGrant: db.prepare('DELETE FROM device_grants WHERE id=?'),
    deleteGrantOf: db.prepare('DELETE FROM device_grants WHERE id=? AND user_id=?'),
    grantOf: db.prepare('SELECT * FROM device_grants WHERE id=? AND user_id=?'),
    list: db.prepare('SELECT id,client_name AS clientName,created_at AS createdAt,last_used_at AS lastUsedAt,expires_at AS expiresAt,ip,user_agent AS userAgent FROM device_grants WHERE user_id=? AND expires_at>? ORDER BY last_used_at DESC'),
    sweepGrants: db.prepare('DELETE FROM device_grants WHERE expires_at<=? OR last_used_at<=?'),
  };

  const verificationUri = () => `${String(origin() || '').replace(/\/+$/, '')}/device`;

  /** Issues a fresh access + refresh pair for `grantId`. Call inside a transaction. */
  function issuePair(grantId, grantExpiresAt, at) {
    const access = randomSecret(ACCESS_PREFIX);
    const refresh = randomSecret(REFRESH_PREFIX);
    const accessExpires = Math.min(at + ACCESS_TTL_MS, grantExpiresAt);
    q.insertToken.run(digest(access), grantId, 'access', at, accessExpires);
    q.insertToken.run(digest(refresh), grantId, 'refresh', at, Math.min(at + REFRESH_IDLE_MS, grantExpiresAt));
    return {
      refreshHash: digest(refresh),
      body: {
        access_token: access, token_type: 'Bearer', expires_in: Math.max(1, Math.floor((accessExpires - at) / 1000)),
        refresh_token: refresh, scope: 'api',
      },
    };
  }

  const limited = (key, { limit, windowMs }) => rate.rateLimited(key, limit, windowMs);
  const tooMany = (what) => ({ status: 429, body: { error: 'slow_down', error_description: `Too many ${what}. Try again later.` } });

  /** POST /api/auth/device/code */
  function start(req, body) {
    const address = clientAddress(req);
    // Validate before charging anything, then charge per client name (and per address only when
    // TRUST_PROXY makes the address real), with one server-wide backstop.
    const clientName = cleanClientName(body?.client_name) || cleanClientName(body?.client_id);
    if (!clientName) return oauthError('invalid_request', 'client_name is required.');
    if (limited('device-code:global', LIMITS.codeGlobal)
      || limited(`device-code:name:${clientName.toLowerCase()}`, LIMITS.codeName)
      || (addressesTrusted && limited(`device-code:address:${address}`, LIMITS.codeAddress))) {
      return tooMany('sign-in requests');
    }
    const at = now();
    const deviceCode = randomSecret();
    let userCode = '';
    const created = db.transaction(() => {
      q.sweep.run(at);
      if (q.pending.get().n >= MAX_PENDING) return false;
      for (let i = 0; i < 5 && !userCode; i++) {
        const candidate = randomUserCode();
        if (!q.byUserCode.get(digest(candidate))) userCode = candidate;
      }
      if (!userCode) return false;
      q.insertAuthorization.run(digest(deviceCode), digest(userCode), clientName, address,
        String(req.headers?.['user-agent'] || '').slice(0, 300), at, at + DEVICE_CODE_TTL_MS, POLL_INTERVAL_MS);
      return true;
    })();
    if (!created) return { status: 503, body: { error: 'temporarily_unavailable', error_description: 'Device sign-in is busy. Try again in a few minutes.' } };
    const uri = verificationUri();
    return { status: 200, body: {
      device_code: deviceCode, user_code: formatUserCode(userCode),
      verification_uri: uri, verification_uri_complete: `${uri}?code=${formatUserCode(userCode)}`,
      expires_in: DEVICE_CODE_TTL_MS / 1000, interval: POLL_INTERVAL_MS / 1000,
    } };
  }

  function exchangeDeviceCode(body, at) {
    const deviceCode = typeof body?.device_code === 'string' ? body.device_code : '';
    const row = deviceCode ? q.byDeviceCode.get(digest(deviceCode)) : null;
    if (!row) return oauthError('invalid_grant', 'Unknown device code.');
    if (row.expires_at <= at) {
      q.deleteAuthorization.run(row.device_code_hash);
      return oauthError('expired_token', 'The sign-in request expired. Start again.');
    }
    if (row.status === 'denied') {
      q.deleteAuthorization.run(row.device_code_hash);
      return oauthError('access_denied', 'The sign-in request was denied.');
    }
    if (row.status === 'pending') {
      // RFC 8628 §3.5: polling faster than the interval earns slow_down and a longer interval.
      if (row.last_poll_at && at - row.last_poll_at < row.interval_ms) {
        q.poll.run(at, row.interval_ms + SLOW_DOWN_STEP_MS, row.device_code_hash);
        return oauthError('slow_down', 'Polling too fast.');
      }
      q.poll.run(at, row.interval_ms, row.device_code_hash);
      return oauthError('authorization_pending', 'Waiting for approval in the browser.');
    }
    // Approved: the device code is single use. Claim it and mint the grant atomically.
    const issued = db.transaction(() => {
      if (q.deleteAuthorization.run(row.device_code_hash).changes !== 1) return null;
      const user = q.userRow.get(row.user_id);
      if (!user || user.disabled_at) return null;
      const grantId = crypto.randomBytes(16).toString('hex');
      const expiresAt = at + GRANT_ABSOLUTE_MS;
      q.insertGrant.run(grantId, user.id, row.client_name, at, at, expiresAt, row.ip, row.user_agent);
      return { grantId, userId: user.id, tokens: issuePair(grantId, expiresAt, at).body };
    })();
    if (!issued) return oauthError('invalid_grant', 'The sign-in request is no longer valid.');
    audit('device.token', issued.userId, issued.userId, { grantId: issued.grantId, clientName: row.client_name });
    return { status: 200, body: issued.tokens };
  }

  /**
   * The refresh grant. A refresh token is single use, with one exception (review F3): for
   * REFRESH_GRACE_MS after its first use, while the token that replaced it has not been used, it
   * may be presented again. That is a client retrying after the answer was lost in transit. The
   * unused successor is then discarded (marked used, not deleted) and a new pair issued, and the
   * grace use is audited as device.refresh_grace; the window is measured from the first use and
   * never extended. Any other second use, including presenting a discarded successor, is reuse
   * and revokes the whole grant.
   */
  function exchangeRefreshToken(body, at, retrying = false) {
    const token = typeof body?.refresh_token === 'string' ? body.refresh_token : '';
    const row = token.startsWith(REFRESH_PREFIX) ? q.tokenRow.get(digest(token)) : null;
    if (!row || row.kind !== 'refresh') return oauthError('invalid_grant', 'Unknown refresh token.');
    const revokeForReuse = () => {
      q.deleteGrant.run(row.grant_id);
      audit('device.refresh_reuse', null, row.user_id, { grantId: row.grant_id, clientName: row.client_name });
      return oauthError('invalid_grant', 'This refresh token was already used. The device was signed out.');
    };
    const inGrace = row.used_at && row.replaced_by && at - row.used_at <= REFRESH_GRACE_MS
      && q.tokenState.get(row.replaced_by)?.used_at === null;
    if (row.used_at && !inGrace) return revokeForReuse();
    if (row.grant_expires_at <= at || row.token_expires_at <= at || row.last_used_at + REFRESH_IDLE_MS <= at) {
      q.deleteGrant.run(row.grant_id);
      return oauthError('invalid_grant', 'The device sign-in expired. Sign in again.');
    }
    const user = q.userRow.get(row.user_id);
    if (!user || user.disabled_at) return oauthError('invalid_grant', 'The account is not available.');
    // R1: refused before rotating, so a refused refresh leaves the current pair working.
    if (!retrying && limited(`device-token:grant:${row.grant_id}`, LIMITS.tokenGrant)) return tooMany('refreshes for this device');
    const rotated = db.transaction(() => {
      if (inGrace) {
        // Discard the successor only if it is still unused (it may have been used meanwhile). It is
        // kept, not deleted: whoever holds it and presents it later triggers reuse detection. That
        // is how a thief who replayed the previous token inside the window gets caught (N2).
        if (q.discard.run(at, row.replaced_by).changes !== 1) return null;
        q.dropAccess.run(row.grant_id);
        q.touchGrant.run(at, row.grant_id);
        const pair = issuePair(row.grant_id, row.grant_expires_at, at);
        q.setReplacedBy.run(pair.refreshHash, row.token_hash);
        q.prune.run(row.grant_id, at - REFRESH_GRACE_MS, row.token_hash);
        return pair.body;
      }
      // Two concurrent refreshes with one token: the loser sees changes 0 and is looked at again.
      if (q.markUsed.run(at, null, row.token_hash).changes !== 1) return null;
      q.dropAccess.run(row.grant_id);
      q.touchGrant.run(at, row.grant_id);
      const pair = issuePair(row.grant_id, row.grant_expires_at, at);
      q.setReplacedBy.run(pair.refreshHash, row.token_hash);
      q.prune.run(row.grant_id, at - REFRESH_GRACE_MS, row.token_hash);
      return pair.body;
    })();
    if (rotated) {
      if (inGrace) audit('device.refresh_grace', null, row.user_id, { grantId: row.grant_id, clientName: row.client_name });
      return { status: 200, body: rotated };
    }
    // Lost a race: re-read once, so a concurrent first use is judged by the same grace rule.
    return retrying ? revokeForReuse() : exchangeRefreshToken(body, at, true);
  }

  /** The presented credential's hash when it names a stored device code or refresh token. */
  function knownCredential(grant, credential) {
    const hash = digest(credential);
    if (grant === DEVICE_GRANT_TYPE) return q.byDeviceCode.get(hash) ? hash : '';
    return credential.startsWith(REFRESH_PREFIX) && q.tokenState.get(hash) ? hash : '';
  }

  /** POST /api/auth/device/token: the device-code exchange and the refresh grant. */
  function token(req, body) {
    const grant = body?.grant_type;
    if (grant !== DEVICE_GRANT_TYPE && grant !== 'refresh_token') {
      return oauthError('unsupported_grant_type', 'Use the device_code or refresh_token grant.');
    }
    const credential = grant === DEVICE_GRANT_TYPE ? body.device_code : body.refresh_token;
    if (typeof credential !== 'string' || !credential || credential.length > 256) {
      return oauthError('invalid_request', grant === DEVICE_GRANT_TYPE ? 'device_code is required.' : 'refresh_token is required.');
    }
    // Charged to the credential, never to the (shared) address: junk cannot use up a device's budget.
    const hash = knownCredential(grant, credential);
    if (!hash) {
      const bucket = addressesTrusted ? `device-token:unknown:${clientAddress(req)}` : 'device-token:unknown';
      if (limited(bucket, LIMITS.tokenUnknown)) return tooMany('token requests with unknown credentials');
      return oauthError('invalid_grant', grant === DEVICE_GRANT_TYPE ? 'Unknown device code.' : 'Unknown refresh token.');
    }
    if (limited(`device-token:credential:${hash}`, LIMITS.tokenCredential)) return tooMany('token requests');
    if (grant === DEVICE_GRANT_TYPE && !limited(`device-token:global-share:${hash}`, LIMITS.tokenGlobalShare)
      && limited('device-token:global', LIMITS.tokenGlobal)) {
      return tooMany('token requests');
    }
    const at = now();
    return grant === DEVICE_GRANT_TYPE ? exchangeDeviceCode(body, at) : exchangeRefreshToken(body, at);
  }

  /**
   * The request's device identity, or null. Only an `Authorization: Bearer nva_…` header counts.
   * The effective role is always `member`; `accountRole` keeps the stored one for callers that
   * need the account's own workspace (never for permission checks).
   */
  function authenticate(req) {
    const raw = bearerToken(req);
    if (!raw) return null;
    const at = now();
    const row = q.tokenRow.get(digest(raw));
    if (!row || row.kind !== 'access' || row.token_expires_at <= at || row.grant_expires_at <= at) return null;
    const user = q.userRow.get(row.user_id);
    if (!user || user.disabled_at) return null;
    // Writes at most once a minute per grant: last-used is shown in Settings, not audited.
    if (at - row.last_used_at >= 60 * 1000) q.touchGrant.run(at, row.grant_id);
    const account = publicUser(user);
    return {
      user: { ...account, role: 'member' }, session: null, legacy: false, accountRole: account.role,
      device: { id: row.grant_id, clientName: row.client_name, expiresAt: row.grant_expires_at },
    };
  }

  function pendingByUserCode(userCode, at) {
    const code = normalizeUserCode(userCode);
    if (!code) return null;
    const row = q.byUserCode.get(digest(code));
    if (!row || row.status !== 'pending' || row.expires_at <= at) return null;
    return { row, code };
  }

  function verifyLimited(userId) {
    return rate.rateLimited(`device-verify:${userId}`, LIMITS.verify.limit, LIMITS.verify.windowMs);
  }

  /** What the approval screen shows for a code, or a 404 when there is no pending request. */
  function lookup(userId, userCode) {
    if (verifyLimited(userId)) return { status: 429, body: { error: 'Too many attempts. Wait a few minutes and try again.' } };
    const found = pendingByUserCode(userCode, now());
    if (!found) return { status: 404, body: { error: 'That code is not valid or has expired.' } };
    const { row, code } = found;
    // Without TRUST_PROXY the address is the tunnel's, the same for everyone: showing it would
    // falsely reassure the person that the request came from them (review F1).
    return { status: 200, body: { clientName: row.client_name, userCode: formatUserCode(code), requestedAt: row.created_at,
      expiresAt: row.expires_at, ip: addressesTrusted ? row.ip : null, userAgent: row.user_agent } };
  }

  /** Approve or deny a pending request for `userId`. Audited either way. `credentialEpoch` is the
   *  account's users.credential_epoch as read with the approving session: an approval is refused
   *  if an account recovery changed it since (the route reads the request body in between), and
   *  refused when it is missing: approvals fail closed. */
  function decide(userId, userCode, approve, credentialEpoch) {
    if (verifyLimited(userId)) return { status: 429, body: { error: 'Too many attempts. Wait a few minutes and try again.' } };
    const at = now();
    const found = pendingByUserCode(userCode, at);
    if (!found) return { status: 404, body: { error: 'That code is not valid or has expired.' } };
    const { row } = found;
    const status = approve ? 'approved' : 'denied';
    const decided = db.transaction(() => {
      if (approve && (credentialEpoch === undefined || credentialEpoch === null || !db.prepare('SELECT 1 FROM users WHERE id=? AND credential_epoch=? AND disabled_at IS NULL').get(userId, credentialEpoch))) return false;
      return q.decide.run(status, approve ? userId : null, at, row.device_code_hash, at).changes === 1;
    })();
    if (!decided) return { status: 404, body: { error: 'That code is not valid or has expired.' } };
    audit(approve ? 'device.approve' : 'device.deny', userId, userId, { clientName: row.client_name, ip: row.ip });
    return { status: 200, body: { ok: true, approved: !!approve, clientName: row.client_name } };
  }

  function list(userId) {
    const at = now();
    q.sweepGrants.run(at, at - REFRESH_IDLE_MS);
    return q.list.all(userId, at).map((d) => (addressesTrusted ? d : { ...d, ip: null }));
  }

  /**
   * Deletes every grant, and so every device token (review F4: switching the feature off is a
   * revoke, not a pause). One audit entry per affected account. Returns the number deleted.
   */
  function revokeAll(actorId, reason) {
    const affected = q.grantsByUser.all();
    // Pending and approved-but-unredeemed requests too: none may turn into a grant afterwards.
    q.deleteAllAuthorizations.run();
    if (!affected.length) return 0;
    q.deleteAllGrants.run();
    let total = 0;
    for (const { user_id: userId, n } of affected) {
      total += n;
      audit('device.revoke_all', actorId || null, userId, { count: n, reason });
    }
    return total;
  }

  /** Deletes one of `userId`'s grants and every token in it. Takes effect on the next request. */
  function revoke(userId, grantId, actorId = userId, reason = 'settings') {
    const grant = q.grantOf.get(String(grantId || ''), userId);
    if (!grant) return false;
    q.deleteGrantOf.run(grant.id, userId);
    audit('device.revoke', actorId, userId, { grantId: grant.id, clientName: grant.client_name, reason });
    return true;
  }

  return { start, token, authenticate, lookup, decide, list, revoke, revokeAll };
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
      if (enabled() && bearerToken(req)) return hasSessionCookie(req) ? null : deviceAuth.authenticate(req);
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

module.exports = {
  createDeviceAuth, createRequestAuth, ensureDeviceSchema, browserOnly, bearerToken, hasSessionCookie, normalizeUserCode, cleanClientName,
  DEVICE_GRANT_TYPE, ACCESS_PREFIX, REFRESH_PREFIX, ACCESS_TTL_MS, DEVICE_CODE_TTL_MS, POLL_INTERVAL_MS, REFRESH_IDLE_MS,
  GRANT_ABSOLUTE_MS, REFRESH_GRACE_MS, LIMITS, BROWSER_ONLY,
};
