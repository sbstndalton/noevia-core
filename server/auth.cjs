'use strict';

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const Database = require('better-sqlite3');
const { DEFAULT_S3_REGION, normalizeS3Region } = require('./s3-region.cjs');

// Sessions are issued by the Rust front (#1071); the gate still refuses one idle this long.
const IDLE_MS = 7 * 24 * 60 * 60 * 1000;

// Client IP resolution. By default the direct socket address is used.
// Behind a reverse proxy (a documented first-class deployment), every
// request would otherwise appear to come from the proxy IP, collapsing
// per-IP rate limiting into one shared bucket and making audit-log IPs
// useless. When trustProxy is enabled, the rightmost X-Forwarded-For
// entry is used: it is the value the trusted proxy appended, so a client
// cannot spoof it via its own leftmost XFF entries. The header is only
// consulted when trustProxy is on, and its value must parse as an IP.
//
// The Rust front (NOEVIA_FRONT=rust) answers for the address in X-Noevia-Client-Ip, with or without
// TRUST_PROXY, and drops any copy the client sent (noevia-rs legacy_proxy.rs, #1245). Node believes
// that header only from a loopback peer (the front is the only thing that reaches Node on loopback
// in that deployment), only with NOEVIA_FRONT=rust, and only when the web supervisor confirmed that
// this front strips client copies of it (NOEVIA_FRONT_CLIENT_IP=1, set when `noevia-server
// --features` lists client-address-header; #1578). A front that predates the strip would forward a
// client-chosen value from its own loopback peer, so version skew or an rs rollback fails closed:
// the header is ignored and the socket (or TRUST_PROXY's XFF) decides. With NOEVIA_FRONT=node, or
// from any other peer, the header is ignored too, so a client that reaches Node directly cannot
// choose its address.
const FRONT_CLIENT_ADDRESS = 'x-noevia-client-ip';
function isLoopbackAddress(addr) {
  const a = String(addr || '').toLowerCase().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');
  return a === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}
function frontClientAddress(req, front) {
  if (!front || !isLoopbackAddress(req.socket?.remoteAddress)) return null;
  const v = req.headers?.[FRONT_CLIENT_ADDRESS];
  const addr = typeof v === 'string' ? v.trim() : '';
  return net.isIP(addr) ? addr : null;
}

function clientAddress(req, trustProxy = false, { front = process.env.NOEVIA_FRONT === 'rust' && process.env.NOEVIA_FRONT_CLIENT_IP === '1' } = {}) {
  const remote = String(req.socket?.remoteAddress || 'unknown');
  const fromFront = frontClientAddress(req, front);
  if (fromFront) return fromFront;
  if (!trustProxy) return remote;
  const forwarded = String(req.headers['x-forwarded-for'] || '');
  const entries = forwarded.split(',').map((s) => s.trim()).filter(Boolean);
  const candidate = entries[entries.length - 1] || '';
  if (candidate && net.isIP(candidate)) return candidate;
  return remote;
}

// Fixed-window rate limiter with bounded memory: expired entries are swept
// periodically, and a hard cap plus eviction bound the map even under a
// flood of unique keys (the old map grew forever, one permanent entry per
// distinct key). Exported for tests.
function createRateLimiter({ sweepMs = 60 * 1000, maxEntries = 10000, now: clock = Date.now } = {}) {
  const map = new Map();
  let lastSweep = clock();
  function sweep(now) {
    for (const [key, entry] of map) {
      if (entry.reset <= now) map.delete(key);
    }
  }
  /** Count one call to `key`. `window` identifies the window it was counted in (its reset time). */
  function charge(key, limit = 5, windowMs = 15 * 60 * 1000) {
    const now = clock();
    if (now - lastSweep >= sweepMs) {
      lastSweep = now;
      sweep(now);
    }
    if (!map.has(key) && map.size >= maxEntries) sweep(now); // reclaim space first
    if (!map.has(key) && map.size >= maxEntries) {
      // Still full after sweeping: hard-evict oldest-inserted entries.
      for (const oldest of map.keys()) {
        map.delete(oldest);
        if (map.size < maxEntries) break;
      }
    }
    const current = map.get(key);
    if (!current || current.reset <= now) {
      const entry = { count: 1, reset: now + windowMs };
      map.set(key, entry);
      return { limited: false, window: entry.reset };
    }
    current.count += 1;
    return { limited: current.count > limit, window: current.reset };
  }
  return {
    charge,
    rateLimited(key, limit = 5, windowMs = 15 * 60 * 1000) {
      return charge(key, limit, windowMs).limited;
    },
    /** Whether `key` is over `limit` in its current window, without counting this call. */
    blocked(key, limit = 5) {
      const current = map.get(key);
      return !!current && current.reset > clock() && current.count > limit;
    },
    /** Forget `key`'s window (a successful sign-in clears that account's failure count). */
    clear(key) { map.delete(key); },
    /** Give back one call counted by `charge` in `window`. A call counted in an earlier window is
     *  not refunded from a later one, so refunds can never lift a window above its limit. */
    release(key, window) {
      const current = map.get(key);
      if (current && current.reset === window && current.reset > clock() && current.count > 0) current.count -= 1;
    },
    size: () => map.size,
  };
}

/** The startup warning for a public https address with TRUST_PROXY off, or '' (#927). Only says
 *  what is wrong and what to set; no configuration values are included. */
function trustProxyWarning(origin, trustProxy) {
  if (trustProxy || !/^https:\/\//i.test(String(origin || ''))) return '';
  return 'WARNING: the public address uses https but TRUST_PROXY is off. If noevia runs behind a reverse proxy or tunnel, '
    + 'every visitor shares the proxy\'s address, so sign-in limits and audit-log addresses apply to everyone at once. '
    + 'Set TRUST_PROXY=true when the proxy sets X-Forwarded-For.';
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

// Mirrors apps/web/src/browser-support.ts's classifyOrigin() — keep in sync.
// A private-network http:// origin is accepted so first-run setup works by
// just loading the app at a bare LAN IP; a public http:// domain is not —
// that must use https.
function isAcceptablePublicOrigin(originStr) {
  let u;
  try { u = new URL(originStr); } catch { return false; }
  if (u.protocol === 'https:') return true;
  if (u.protocol !== 'http:') return false;
  const host = u.hostname;
  if (host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '::1') return true;
  if (/^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (host !== '' && !host.includes('.') && !host.includes(':')) return true; // bare LAN hostname
  return false;
}

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

// A cookie with a malformed % escape (set by any other app on the same host or a parent
// domain) must not throw here: authenticate() runs before the request's error handling, so a
// throw reset every request from that browser (#781). Such a value is kept raw.
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const raw = part.slice(i + 1);
    let value = raw;
    try { value = decodeURIComponent(raw); } catch { /* keep the raw value */ }
    out[part.slice(0, i).trim()] = value;
  }
  return out;
}

function createAuth({ dataDir, publicOrigin, rpId, legacyToken = '', legacyCompat = false, secrets = null, trustProxy = false, additionalOrigins = [], rustAuth = null }) {
  // M3 (rust-auth.cjs), permanent since sbstndalton/noevia#1071: the Rust front answers sign-in and
  // the account and writes their tables; this process only reads them (plus the exemptions).
  const guard = rustAuth || require('./rust-auth.cjs').createRustAuthGuard();
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new Database(path.join(dataDir, 'cowork.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users(
      id TEXT PRIMARY KEY, username TEXT NOT NULL, username_norm TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','member')),
      password_hash TEXT NOT NULL, webauthn_user_id TEXT NOT NULL UNIQUE,
      disabled_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions(
      id_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      csrf_hash TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, user_agent TEXT NOT NULL, ip TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS passkeys(
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL, public_key BLOB NOT NULL, webauthn_user_id TEXT NOT NULL,
      counter INTEGER NOT NULL, device_type TEXT NOT NULL, backed_up INTEGER NOT NULL,
      transports TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS challenges(
      id_hash TEXT PRIMARY KEY, user_id TEXT, kind TEXT NOT NULL, challenge TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS challenges_expires_at_idx ON challenges(expires_at);
    CREATE TABLE IF NOT EXISTS invitations(
      token_hash TEXT PRIMARY KEY, created_by TEXT NOT NULL REFERENCES users(id),
      role TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS recoveries(
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_by TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL,
      used_at INTEGER, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_events(
      id INTEGER PRIMARY KEY AUTOINCREMENT, actor_user_id TEXT, target_user_id TEXT,
      action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS storage_connections(
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, base_url TEXT NOT NULL DEFAULT '', bucket TEXT NOT NULL DEFAULT '',
      username TEXT NOT NULL DEFAULT '',
      secret TEXT NOT NULL DEFAULT '', corpus_root TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_appearance(
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      value TEXT NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_features(
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      diary_enabled INTEGER NOT NULL DEFAULT 0, onboarded INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(1, unixepoch() * 1000);
    INSERT OR IGNORE INTO user_features(user_id, diary_enabled, updated_at)
      SELECT id, 1, unixepoch() * 1000 FROM users
      WHERE NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version=2);
    INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(2, unixepoch() * 1000);
  `);
  // v3: per-user onboarding flag. Default 1 = pre-wizard (legacy or
  // already-completed) users are never bounced into the setup wizard; the
  // first-run wizard explicitly sets 0 for the account it creates and flips it
  // back to 1 when onboarding finishes. Column add is guarded because fresh
  // databases already include it in the CREATE TABLE above.
  if (!db.prepare('PRAGMA table_info(user_features)').all().some((c) => c.name === 'onboarded')) {
    db.exec(`ALTER TABLE user_features ADD COLUMN onboarded INTEGER NOT NULL DEFAULT 1;
      UPDATE user_features SET onboarded = 1;`);
  }
  db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(3, unixepoch() * 1000)').run();
  // v4: bucket column for S3-compatible storage connections. Column add is
  // guarded because fresh databases already include it in the CREATE TABLE.
  if (!db.prepare('PRAGMA table_info(storage_connections)').all().some((c) => c.name === 'region')) {
    db.exec("ALTER TABLE storage_connections ADD COLUMN region TEXT NOT NULL DEFAULT 'us-east-1'");
  }
  if (!db.prepare('PRAGMA table_info(storage_connections)').all().some((c) => c.name === 'bucket')) {
    db.exec("ALTER TABLE storage_connections ADD COLUMN bucket TEXT NOT NULL DEFAULT ''");
  }
  db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(4, unixepoch() * 1000)').run();
  // v5: opt-in Insights badge. insights_badge is the user's preference (off by
  // default — proactive surfacing must never be assumed for something this
  // personal); insights_seen_at is the epoch-ms timestamp of the last time the
  // user looked at the Insights view, so the badge only fires on genuinely new
  // standing-section activity. Both guarded column adds.
  if (!db.prepare('PRAGMA table_info(user_features)').all().some((c) => c.name === 'insights_badge')) {
    db.exec('ALTER TABLE user_features ADD COLUMN insights_badge INTEGER NOT NULL DEFAULT 0');
  }
  if (!db.prepare('PRAGMA table_info(user_features)').all().some((c) => c.name === 'insights_seen_at')) {
    db.exec('ALTER TABLE user_features ADD COLUMN insights_seen_at INTEGER');
  }
  db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(5, unixepoch() * 1000)').run();
  // Native-client device grants (#555, device-auth.cjs). The tables exist whether or not the
  // feature is on, so disabling an account or resetting its password always revokes them.
  require('./device-auth.cjs').ensureDeviceSchema(db);
  // Credential epoch (#928): bumped when recovery revokes every credential. Credential creation
  // that awaits a slow step (passkey verification, app-password hashing) snapshots it first and
  // inserts only if it is unchanged, so an in-flight request cannot add one after a recovery.
  if (!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'credential_epoch')) {
    db.exec('ALTER TABLE users ADD COLUMN credential_epoch INTEGER NOT NULL DEFAULT 0');
  }

  const setting = (key) => db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value;
  const configuredOrigin = setting('public_origin');
  // An address an administrator chose in Settings → Web address wins over the environment, so
  // renaming the site never needs a server-side file edit. PUBLIC_ORIGIN stays the default.
  const adminOrigin = setting('public_origin_admin');
  let origin = adminOrigin || publicOrigin || configuredOrigin || '';
  let originSource = adminOrigin ? 'settings' : publicOrigin ? 'environment' : configuredOrigin ? 'setup' : 'none';
  // Passkeys belong to the name they were made under. After a rename the old name stays the
  // passkey name (saved as passkey_rp_id) and the new address is declared a related origin
  // (GET /.well-known/webauthn on the old host), so existing passkeys keep working.
  // New passkeys are always made for the current address. Each passkey remembers the name it was
  // made under (passkeys.rp_id), so after a rename the old ones still sign in (browsers that
  // support related origins accept them via /.well-known/webauthn on the old host).
  // WEBAUTHN_RP_ID may pin a parent domain (e.g. example.com for app.example.com). It only applies
  // while it fits the current address: after a rename to another name it would make every new
  // passkey fail ("RP ID is invalid for this domain"), so the address's own name wins.
  const rpFor = (o) => {
    const host = o ? new URL(o).hostname : 'localhost';
    return rpId && (host === rpId || host.endsWith(`.${rpId}`)) ? rpId : host;
  };
  let relyingPartyId = rpFor(origin);
  if (!db.prepare('PRAGMA table_info(passkeys)').all().some((c) => c.name === 'rp_id')) db.exec('ALTER TABLE passkeys ADD COLUMN rp_id TEXT');
  db.prepare('UPDATE passkeys SET rp_id=? WHERE rp_id IS NULL').run(setting('passkey_rp_id') || relyingPartyId);
  db.prepare("DELETE FROM settings WHERE key='passkey_rp_id'").run();
  // A random, public id so noevia can tell whether a new address really reaches this server.
  if (!setting('instance_id')) db.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES('instance_id',?)").run(crypto.randomUUID());
  const instanceId = setting('instance_id');
  // Password/session login can be reachable from more than one origin (e.g. a
  // Cloudflare Tunnel hostname plus a bare LAN IP for local access) even
  // though only one origin can ever be the WebAuthn RP — passkeys are bound to
  // `origin`/`relyingPartyId` and will never work from an IP-address origin
  // regardless of this list, per the WebAuthn spec (RP ID must be a domain).
  let trustedOrigins = new Set(additionalOrigins.filter(Boolean));
  // Earlier addresses keep working for sign-in after a rename, so nobody is locked out mid-move.
  let previousOrigins = [];
  try { previousOrigins = JSON.parse(setting('previous_origins') || '[]').filter((o) => typeof o === 'string'); } catch { previousOrigins = []; }
  for (const o of previousOrigins) trustedOrigins.add(o);
  const setupFile = path.join(dataDir, 'first-run-setup-code');

  /** The Rust front owns first-run setup (M3), so the address it chose is in settings only:
   *  every use reads it again, the way a restart would (settings -> PUBLIC_ORIGIN -> setup). */
  function refreshOrigin() {
    const admin = setting('public_origin_admin');
    const configured = setting('public_origin');
    origin = admin || publicOrigin || configured || '';
    originSource = admin ? 'settings' : publicOrigin ? 'environment' : configured ? 'setup' : 'none';
    relyingPartyId = rpFor(origin);
    try { previousOrigins = JSON.parse(setting('previous_origins') || '[]').filter((o) => typeof o === 'string'); } catch { previousOrigins = []; }
    trustedOrigins = new Set([...additionalOrigins.filter(Boolean), ...previousOrigins]);
  }

  /** Every address a passkey ceremony may come from: the current one and earlier ones. */
  function passkeyOrigins() {
    refreshOrigin();
    const current = origin || setting('public_origin');
    return [...new Set([current, ...previousOrigins].filter(Boolean))];
  }

  function userCount() {
    return db.prepare('SELECT count(*) AS n FROM users').get().n;
  }

  if (userCount() === 0 && !fs.existsSync(setupFile)) {
    const code = randomToken(16);
    fs.writeFileSync(setupFile, `${code}\n`, { mode: 0o600, flag: 'wx' });
    db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('setup_code_hash',?)").run(digest(code));
    console.warn(`FIRST-RUN SETUP CODE: ${code}`);
    console.warn(`Setup code file: ${setupFile} (deleted after setup)`);
  }

  const proxyWarning = trustProxyWarning(origin, trustProxy);
  if (proxyWarning) console.warn(proxyWarning);

  // Everything above is the boot (migrations, the first-run setup code); from here on the
  // Rust-owned tables are written only by the Rust front.
  guard.install(db);

  function publicUser(row) {
    if (!row) return null;
    const feature = db.prepare('SELECT diary_enabled, onboarded FROM user_features WHERE user_id=?').get(row.id);
    return { id: row.id, username: row.username, displayName: row.display_name, role: row.role,
      disabled: !!row.disabled_at, diaryEnabled: !!feature?.diary_enabled, onboarded: !!(feature?.onboarded ?? 1) };
  }

  function authenticate(req) {
    const raw = parseCookies(req).cowork_session;
    const now = Date.now();
    if (raw) {
      const row = db.prepare(`SELECT s.*,u.id AS id,u.username,u.display_name,u.role,u.disabled_at,u.credential_epoch
        FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id_hash=?`).get(digest(raw));
      // The Rust front owns sessions (M3): the gate is read-only. The front moved last_seen_at and
      // deleted a rejected row before it proxied the request (noevia-rs server-auth upkeep).
      if (row && !row.disabled_at && row.expires_at > now && row.last_seen_at + IDLE_MS > now) {
        return { user: publicUser(row), session: row, legacy: false };
      }
    }
    if (legacyCompat && legacyToken && userCount() > 0) {
      const supplied = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const a = Buffer.from(supplied); const b = Buffer.from(legacyToken);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
        const admin = db.prepare("SELECT * FROM users WHERE role='admin' AND disabled_at IS NULL ORDER BY created_at LIMIT 1").get();
        if (admin) return { user: publicUser(admin), session: null, legacy: true };
      }
    }
    return null;
  }

  function csrfValid(req, authn) {
    if (!authn || authn.legacy) return !!authn;
    const value = String(req.headers['x-csrf-token'] || '');
    const cookie = parseCookies(req).cowork_csrf || '';
    return value && value === cookie && digest(value) === authn.session.csrf_hash;
  }

  function originValid(req) {
    refreshOrigin();
    if (!origin) return true;
    const supplied = String(req.headers.origin || '');
    return !supplied || supplied === origin || trustedOrigins.has(supplied);
  }

  function audit(action, actor, target, detail = {}) {
    db.prepare('INSERT INTO audit_events(actor_user_id,target_user_id,action,detail,created_at) VALUES(?,?,?,?,?)')
      .run(actor || null, target || null, action, JSON.stringify(detail), Date.now());
  }

  return {
    appPasswords: require('./app-passwords.cjs').createAppPasswords({ db, guard }),
    /** The M3 single-writer guard (rust-auth.cjs), for the modules wired to this database. */
    rustAuth: guard,
    db, get origin() { refreshOrigin(); return origin; }, get rpId() { refreshOrigin(); return relyingPartyId; }, get originSource() { refreshOrigin(); return originSource; }, instanceId,
    get previousOrigins() { refreshOrigin(); return [...previousOrigins]; },
    /** WebAuthn related origins, served at /.well-known/webauthn on the passkey name's host. */
    relatedOrigins: () => passkeyOrigins(),
    userCount, authenticate, csrfValid, originValid, publicUser,
    // Exposed for the tool permission gate (step 16): every write tool call is
    // recorded here, so "what did the model actually do on my behalf" is
    // answerable from the same log as logins and storage changes.
    audit,
    listUsers() { return db.prepare('SELECT * FROM users ORDER BY created_at').all().map(publicUser); },
    diaryEnabled(userId) {
      return !!db.prepare('SELECT diary_enabled FROM user_features WHERE user_id=?').get(userId)?.diary_enabled;
    },
    deleteUser(actorId, userId, username) {
      const user = db.prepare('SELECT * FROM users WHERE id=?').get(userId); if (!user || user.username !== username) return false;
      if (user.role === 'admin' && (db.prepare("SELECT count(*) AS n FROM users WHERE role='admin'").get().n <= 1 ||
          (!user.disabled_at && db.prepare("SELECT count(*) AS n FROM users WHERE role='admin' AND disabled_at IS NULL").get().n <= 1))) throw new Error('cannot delete the last active administrator');
      // Account deletion stays Node's (its cleanup spans Node's own stores): rust-auth.cjs exemption.
      guard.exempt(() => db.transaction(() => {
        // Issued tokens reference their creator without ON DELETE CASCADE.
        // Revoke them with the account, retaining provenance in audit_events.
        db.prepare('DELETE FROM invitations WHERE created_by=?').run(userId);
        db.prepare('DELETE FROM recoveries WHERE created_by=?').run(userId);
        db.prepare('DELETE FROM users WHERE id=?').run(userId);
        audit('user.delete', actorId, userId);
      })());
      return true;
    },
    getStorage(userId, includeSecret = false) {
      const row = db.prepare('SELECT * FROM storage_connections WHERE user_id=?').get(userId);
      if (!row) return { kind: 'local', baseUrl: '', bucket: '', region: DEFAULT_S3_REGION, username: '', corpusRoot: '' };
      let plain = ''; let needsReauth = false;
      try { plain = secrets ? secrets.decrypt(row.secret, userId) : row.secret; } catch {
        // Lost or rotated secrets.key, or a ciphertext bound to another account.
        console.warn(`storage secret for user ${userId} could not be decrypted; treating it as unset`);
        plain = ''; needsReauth = !!row.secret;
      }
      // Upgrade a legacy unbound (v1) ciphertext or a plaintext secret to the account-bound format.
      if (secrets && plain && !String(row.secret).startsWith('enc:v2:')) {
        db.prepare('UPDATE storage_connections SET secret=? WHERE user_id=?').run(secrets.encrypt(plain, userId), userId);
      }
      return { kind: row.kind, baseUrl: row.base_url, bucket: row.bucket || '', region: normalizeS3Region(row.region), username: row.username, corpusRoot: row.corpus_root,
        secret: includeSecret ? plain : undefined, secretConfigured: !!plain, secretNeedsReauth: needsReauth };
    },
    saveStorage(userId, value) {
      const kind = ['local', 'nextcloud', 'webdav', 's3'].includes(value.kind) ? value.kind : 'local';
      const encrypted = secrets ? secrets.encrypt(value.secret || '', userId) : (value.secret || '');
      db.prepare(`INSERT INTO storage_connections(user_id,kind,base_url,bucket,region,username,secret,corpus_root,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET kind=excluded.kind,base_url=excluded.base_url,
        bucket=excluded.bucket,region=excluded.region,username=excluded.username,secret=excluded.secret,corpus_root=excluded.corpus_root,updated_at=excluded.updated_at`)
        .run(userId, kind, String(value.baseUrl || '').replace(/\/+$/, ''), String(value.bucket || '').replace(/\/+$/, ''),
          normalizeS3Region(value.region), String(value.username || ''), encrypted, String(value.corpusRoot || ''), Date.now());
      audit('storage.update', userId, userId, { kind });
      return this.getStorage(userId);
    },
  };
}

module.exports = { createAuth, digest, createRateLimiter, clientAddress, parseCookies, trustProxyWarning };
