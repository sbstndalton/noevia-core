'use strict';
// The cross-runtime single-writer guard for M3 of the full-Rust migration (noevia
// docs/adr-0001-rust-and-repo-split.md, "Amendment 2026-10-10"): the Rust front (noevia-rs
// bins/noevia-server) owns sign-in and the account routes and the tables they write, and this
// process refuses to write them, so every owned row has one writer.
//
// Permanent since sbstndalton/noevia#1071: the deployment switch NOEVIA_RUST_AUTH and its
// confirmation are retired and not read here; the guard is always installed. Node's copies of
// the routes are gone (OWNED_ROUTES below are refused before anything else runs), and the web
// supervisor refuses to start without NOEVIA_FRONT=rust and a front that lists rust-auth.
//
// Always:
//   - every statement prepared on the auth database that INSERTs into, UPDATEs or DELETEs from an
//     owned table (or writes an owned settings key) throws when it runs: status 503, code
//     RUST_AUTH_OWNED. Reads are untouched. Writes made at boot (migrations, the first-run setup
//     code) happen before the guard is installed.
//   - the request gate is read-only: a session's last_seen_at, a rejected session's deletion and
//     a device grant's last_used_at are written by the front before it proxies (server-auth
//     upkeep), not here.
//   - the public address is re-read from settings on every use, since first-run setup now runs in
//     Rust (auth.cjs).
//
// What stays Node's and runs inside exempt(): deleting an account (its cleanup spans Node's own
// stores), Settings -> Web address (changeOrigin), revoking every device grant when native-client
// sign-in is switched off, and the DAV listener's app_passwords.last_used_at. audit_events is
// shared, append-only, by both. noevia-rs crates/server-store OWNED_TABLES is the other half of
// this list; keep them equal.

const OWNED_TABLES = Object.freeze(new Set([
  'sessions', 'users', 'user_features', 'user_appearance', 'passkeys', 'challenges', 'invitations', 'recoveries',
  'device_authorizations', 'device_grants', 'device_tokens', 'app_passwords',
]));
const OWNED_SETTING_KEYS = Object.freeze(new Set(['setup_code_hash', 'public_origin', 'public_origin_admin', 'previous_origins', 'passkey_decoy_key']));

// An identifier, bare or quoted ("x", `x`, [x]); a schema qualifier (main.users, "main"."users") is
// allowed in front and ignored.
const IDENT = '(?:"[^"]+"|`[^`]+`|\\[[^\\]]+\\]|[A-Za-z_][A-Za-z0-9_$]*)';
const WRITE_RE = new RegExp(
  `\\b(?:(?:INSERT|UPSERT|REPLACE)(?:\\s+OR\\s+[A-Za-z]+)?\\s+INTO|UPDATE(?:\\s+OR\\s+[A-Za-z]+)?|DELETE\\s+FROM)\\s+(?:${IDENT}\\s*\\.\\s*)?(${IDENT})`, 'gi');
const SETTING_KEY_RE = /\bkey\s*=\s*'([^']*)'|VALUES\s*\(\s*'([^']*)'/i;

/** `sql` without comments and string literals, so a quoted "DELETE FROM users" is not a write. */
function scrub(sql) {
  // One token pass: comment delimiters inside quoted values/identifiers are not comments.
  // SQLite accepts a single-quoted identifier in a table position. Preserve lexical identifier
  // tokens as double-quoted names; a quoted write verb has no following whitespace, so ordinary
  // string payloads cannot become a write. All non-identifier string contents are removed.
  return String(sql).replace(/--[^\n]*|\/\*[\s\S]*?\*\/|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|'(?:[^']|'')*'/g, (token) => {
    if (token.startsWith('--') || token.startsWith('/*')) return ' ';
    if (!token.startsWith("'")) return token;
    return /^'[A-Za-z_][A-Za-z0-9_$]*'$/.test(token) ? `"${token.slice(1, -1)}"` : "''";
  });
}

const unquote = (id) => id.replace(/^["`[]|["`\]]$/g, '').toLowerCase();

// The routes the Rust front answers for sign-in and the account (noevia-rs
// contracts/http/routes.toml, the owner = "rust" account entries; keep them equal). A method that
// is not listed stays Node's (it answers as before). Node has no handler for these any more: a
// request that reaches it bypassed the front and is refused with 503 RUST_AUTH_OWNED.
const ALL = null;
const OWNED_ROUTES = Object.freeze([
  [/^\/api\/account\/(?:instructions|memory|preferences)$/, ALL],
  [/^\/api\/admin\/invitations$/, ['POST']],
  [/^\/api\/admin\/users$/, ['GET']],
  [/^\/api\/admin\/users\/[^/]+\/disabled$/, ['PUT']],
  [/^\/api\/admin\/users\/[^/]+\/recovery$/, ['POST']],
  [/^\/api\/auth\/device\/(?:approve|code|token|lookup)$/, ALL],
  [/^\/api\/auth\/devices(?:\/[^/]+)?$/, ALL],
  [/^\/api\/auth\/invitations\/accept$/, ['POST']],
  [/^\/api\/auth\/login\/(?:password|passkey\/options|passkey\/verify)$/, ['POST']],
  [/^\/api\/auth\/logout$/, ['POST']],
  [/^\/api\/auth\/passkeys\/register\/(?:options|verify)$/, ['POST']],
  [/^\/api\/auth\/passkeys\/[^/]+$/, ['DELETE', 'PATCH']],
  [/^\/api\/auth\/recovery\/complete$/, ['POST']],
  [/^\/api\/auth\/session$/, ['GET']],
  [/^\/api\/auth\/sessions\/[^/]+$/, ['DELETE']],
  [/^\/api\/profile$/, ['GET', 'PATCH']],
  [/^\/api\/profile\/app-passwords$/, ['GET', 'POST']],
  [/^\/api\/profile\/app-passwords\/[^/]+$/, ['DELETE']],
  [/^\/api\/profile\/appearance$/, ALL],
  [/^\/api\/profile\/features$/, ['PUT']],
  [/^\/api\/profile\/onboarding$/, ['POST']],
  [/^\/api\/setup\/complete$/, ['POST']],
  [/^\/api\/setup\/status$/, ['GET']],
]);

const ROUTE_REFUSAL = Object.freeze({ error: 'Sign-in and the account are owned by the Rust front.', code: 'RUST_AUTH_OWNED' });

/** Whether `method path` (a WHATWG pathname) is one of the Rust front's sign-in and account routes. */
function ownedRoute(method, pathname) {
  const m = String(method || 'GET').toUpperCase();
  return OWNED_ROUTES.some(([re, methods]) => re.test(pathname) && (methods === ALL || methods.includes(m)));
}

/** Refuses a Rust-owned sign-in or account route (503 RUST_AUTH_OWNED); false for anything else. */
function refuseOwned(req, res, pathname, json) {
  if (!ownedRoute(req.method, pathname)) return false;
  json(res, 503, ROUTE_REFUSAL);
  return true;
}

/** Every table one SQL statement writes (WITH ... INSERT/UPDATE/DELETE, schema-qualified and quoted
 *  names, INSERT OR REPLACE / REPLACE / UPSERT included), each with the settings key it names
 *  literally. A statement that merely mentions a write verb in a comment or string writes nothing. */
function writeTargets(sql) {
  const raw = String(sql);
  const clean = scrub(raw);
  const out = [];
  for (const m of clean.matchAll(WRITE_RE)) {
    const table = unquote(m[1]);
    if (table === 'set') continue; // ON CONFLICT DO UPDATE SET
    if (table !== 'settings') { out.push({ table, key: null }); continue; }
    const k = SETTING_KEY_RE.exec(raw);
    out.push(Object.defineProperty({ table, key: k ? (k[1] ?? k[2]) : null }, 'sql', { value: raw }));
  }
  return out;
}

/** The first table one SQL statement writes, and the settings key it names literally, or null. */
function writeTarget(sql) {
  return writeTargets(sql)[0] || null;
}

/** The statements of a db.exec() script (no quoted ';' occurs in this codebase's scripts). */
function statements(sql) {
  return String(sql).split(';').map((s) => s.trim()).filter(Boolean);
}

// Recognize only single-key SQL shapes proven by current Node callers. Other settings writes
// may affect any native key and fail closed; this is not a general SQL parser.
function singleSettingKey(sql, args) {
  const source = String(sql).trim().replace(/;$/, '').trim();
  const insert = /^(?:INSERT(?: OR (?:REPLACE|IGNORE))?|REPLACE) INTO settings\s*\(\s*key\s*,\s*value\s*\) VALUES\s*\(\s*(\?|'[^']*')\s*,\s*\?\s*\)$/i.exec(source);
  if (insert) {
    if (insert[1] !== '?') return insert[1].slice(1, -1);
    const value = Array.isArray(args[0]) ? args[0][0] : args[0];
    return typeof value === 'string' ? value : null;
  }
  const del = /^DELETE FROM settings WHERE key='([^']*)'(?: AND value=\?)?$/i.exec(source);
  return del ? del[1] : null;
}
// sbstndalton/noevia#1071: the routing allowed list, the reasoning default and the sampling-presets
// switch are written only by the Rust front (their routes left Node). This connection refuses those
// keys too, even inside exempt(), with their own codes.
const FRONT_SETTING_KEYS = Object.freeze({
  public_origin_admin: ['Web address changes are owned by the Rust front.', 'RUST_WEB_ADDRESS_WRITE_OWNED'],
  previous_origins: ['Web address changes are owned by the Rust front.', 'RUST_WEB_ADDRESS_WRITE_OWNED'],
  routing_modes_allowed: ['Routing settings are owned by the Rust front.', 'RUST_ROUTING_MODE_OWNED'],
  reasoning_effort_default: ['Reasoning settings are written by the Rust front', 'RUST_REASONING_SETTINGS_OWNED'],
  auto_sampling_presets_enabled: ['Sampling settings are written by the Rust front', 'RUST_SAMPLING_SETTINGS_OWNED'],
});
/** The guard. It takes no options: Rust always owns these tables (sbstndalton/noevia#1071). */
function createRustAuthGuard() {
  const enabled = true;
  let exemptDepth = 0;

  function refuse(what) {
    throw Object.assign(new Error(`${what} is written by the Rust front`), { status: 503, code: 'RUST_AUTH_OWNED' });
  }

  /** Throws when running `target` (with `args`) would write what Rust owns. */
  function check(targets, args) {
    if (!targets) return;
    for (const target of Array.isArray(targets) ? targets : [targets]) checkOne(target, args);
  }

  function checkOne(target, args) {
    if (exemptDepth === 0 && OWNED_TABLES.has(target.table)) refuse(target.table);
    if (target.table === 'settings') {
      const key = singleSettingKey(target.sql, args);
      // An unrecognised settings write may touch any key, the front's included: refused even
      // inside exempt(). The front's own keys are refused with their own codes, exempt or not.
      if (key === null) refuse('settings key unknown');
      if (Object.hasOwn(FRONT_SETTING_KEYS, key)) {
        const [message, code] = FRONT_SETTING_KEYS[key];
        throw Object.assign(new Error(message), { status: 503, code });
      }
      if (exemptDepth === 0 && OWNED_SETTING_KEYS.has(key)) refuse(`settings key ${key}`);
    }
  }

  const RUNS = new Set(['run', 'get', 'all', 'iterate']);

  function guardStatement(stmt, target) {
    let boundArgs = null;
    const proxy = new Proxy(stmt, {
      get(t, prop) {
        const value = Reflect.get(t, prop, t);
        if (typeof value !== 'function') return value;
        if (RUNS.has(prop)) return (...args) => { check(target, boundArgs ?? args); return value.apply(t, args); };
        if (prop === 'bind') return (...args) => {
          const out = value.apply(t, args);
          // SQLite has already copied its bindings. Snapshot the only supported bound key now,
          // so later caller-array mutation cannot change the guard's view of that binding.
          boundArgs = [Array.isArray(args[0]) ? [args[0][0]] : args[0]];
          return out === t ? proxy : out;
        };
        // pluck(), raw(), safeIntegers() return the statement itself: keep the guard on it.
        return (...args) => { const out = value.apply(t, args); return out === t ? proxy : out; };
      },
    });
    return proxy;
  }

  return {
    enabled,
    OWNED_TABLES,
    OWNED_SETTING_KEYS,
    /** Runs `fn` (synchronously) with the guard lifted: one of the Node writers listed above. */
    exempt(fn) {
      exemptDepth += 1;
      try { return fn(); } finally { exemptDepth -= 1; }
    },
    /** Installs the guard on a better-sqlite3 database (once per connection). */
    install(db) {
      if (db.__rustAuthGuard) return db;
      const prepare = db.prepare.bind(db);
      const exec = db.exec.bind(db);
      // TEMP triggers protect this Node connection, including indirect trigger writes. Rust's
      // separate connection remains the sole allowed-list writer. Product feature writes stay Node.
      let hasSettings = false;
      try { hasSettings = !!prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings'").get(); } catch { /* no schema yet */ }
      if (hasSettings) exec(`
        CREATE TEMP TRIGGER rust_routing_insert BEFORE INSERT ON main.settings WHEN NEW.key='routing_modes_allowed' BEGIN SELECT RAISE(ABORT,'RUST_ROUTING_MODE_OWNED'); END;
        CREATE TEMP TRIGGER rust_routing_update BEFORE UPDATE ON main.settings WHEN OLD.key='routing_modes_allowed' OR NEW.key='routing_modes_allowed' BEGIN SELECT RAISE(ABORT,'RUST_ROUTING_MODE_OWNED'); END;
        CREATE TEMP TRIGGER rust_routing_delete BEFORE DELETE ON main.settings WHEN OLD.key='routing_modes_allowed' BEGIN SELECT RAISE(ABORT,'RUST_ROUTING_MODE_OWNED'); END;
      `);
      db.prepare = (sql, ...rest) => {
        const stmt = prepare(sql, ...rest);
        const target = writeTargets(sql);
        return target.length ? guardStatement(stmt, target) : stmt;
      };
      db.exec = (sql) => {
        for (const s of statements(sql)) check(writeTargets(s), []);
        return exec(sql);
      };
      Object.defineProperty(db, '__rustAuthGuard', { value: true });
      return db;
    },
  };
}

module.exports = { createRustAuthGuard, ownedRoute, refuseOwned, OWNED_ROUTES, ROUTE_REFUSAL, writeTarget, writeTargets, OWNED_TABLES, OWNED_SETTING_KEYS, FRONT_SETTING_KEYS };
