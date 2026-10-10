'use strict';
// The cross-runtime single-writer guard for M3 of the full-Rust migration (noevia
// docs/adr-0001-rust-and-repo-split.md, "Amendment 2026-10-10"): once the deployment switch is on,
// the Rust front (noevia-rs bins/noevia-server) owns sign-in and the account routes and the tables
// they write, and this process refuses to write them, so every owned row has one writer.
//
// The switch is NOEVIA_RUST_AUTH=1 (exactly) together with NOEVIA_FRONT=rust and the supervisor's
// NOEVIA_RUST_AUTH_CONFIRMED=1 (set only once the front's --features lists rust-auth): the front only
// answers those routes when it faces the network, so with NOEVIA_FRONT=node the switch is ignored
// here (a warning is printed) and Node keeps doing everything, as before.
//
// While it is on:
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
//
// Removed together with Node's copies of the routes once Rust-owned sign-in is proven.

const OWNED_TABLES = Object.freeze(new Set([
  'sessions', 'users', 'user_features', 'user_appearance', 'passkeys', 'challenges', 'invitations', 'recoveries',
  'device_authorizations', 'device_grants', 'device_tokens', 'app_passwords',
]));
const OWNED_SETTING_KEYS = Object.freeze(new Set(['setup_code_hash', 'public_origin', 'public_origin_admin', 'passkey_decoy_key']));

// An identifier, bare or quoted ("x", `x`, [x]); a schema qualifier (main.users, "main"."users") is
// allowed in front and ignored.
const IDENT = '(?:"[^"]+"|`[^`]+`|\\[[^\\]]+\\]|[A-Za-z_][A-Za-z0-9_$]*)';
const WRITE_RE = new RegExp(
  `\\b(?:(?:INSERT|UPSERT|REPLACE)(?:\\s+OR\\s+[A-Za-z]+)?\\s+INTO|UPDATE(?:\\s+OR\\s+[A-Za-z]+)?|DELETE\\s+FROM)\\s+(?:${IDENT}\\s*\\.\\s*)?(${IDENT})`, 'gi');
const SETTING_KEY_RE = /\bkey\s*=\s*'([^']*)'|VALUES\s*\(\s*'([^']*)'/i;

/** `sql` without comments and string literals, so a quoted "DELETE FROM users" is not a write. */
function scrub(sql) {
  return String(sql)
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''");
}

const unquote = (id) => id.replace(/^["`[]|["`\]]$/g, '').toLowerCase();

/** Whether the switch is on for this process (see the header). The supervisor sets
 *  NOEVIA_RUST_AUTH_CONFIRMED=1 only after `noevia-server --features` listed rust-auth: without
 *  that the front may not answer these routes, and refusing Node's writes would lock sign-in out. */
function enabledFrom(env = process.env, warn = console.warn) {
  if (env.NOEVIA_RUST_AUTH !== '1') return false;
  if (env.NOEVIA_FRONT !== 'rust') {
    warn('NOEVIA_RUST_AUTH=1 is ignored: the Rust front answers sign-in only with NOEVIA_FRONT=rust.');
    return false;
  }
  if (env.NOEVIA_RUST_AUTH_CONFIRMED !== '1') {
    warn('NOEVIA_RUST_AUTH=1 is ignored: the supervisor has not confirmed that the Rust front supports rust-auth (NOEVIA_RUST_AUTH_CONFIRMED).');
    return false;
  }
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

// Sampling is a distinct capability. Recognize only bounded, single-key SQL shapes used by
// current Node callers; ambiguous writes may affect the native key and fail closed.
function samplingKey(sql, args) {
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
function createRustAuthGuard({ enabled = false, samplingSettingsEnabled = false } = {}) {
  let exemptDepth = 0;

  function refuse(what) {
    throw Object.assign(new Error(`${what} is written by the Rust front while NOEVIA_RUST_AUTH is on`), { status: 503, code: 'RUST_AUTH_OWNED' });
  }

  /** Throws when running `target` (with `args`) would write what Rust owns. */
  function check(targets, args) {
    if ((!enabled && !samplingSettingsEnabled) || !targets) return;
    for (const target of Array.isArray(targets) ? targets : [targets]) checkOne(target, args);
  }

  function checkOne(target, args) {
    if (enabled && exemptDepth === 0 && OWNED_TABLES.has(target.table)) refuse(target.table);
    if (target.table === 'settings') {
      if (samplingSettingsEnabled) {
        const sampling = samplingKey(target.sql, args);
        if (sampling === null || sampling === 'auto_sampling_presets_enabled') {
          throw Object.assign(new Error('Sampling settings are written by the Rust front'), { status: 503, code: 'RUST_SAMPLING_SETTINGS_OWNED' });
        }
      }
      // A key bound as the first parameter (features.cjs settingsStore.set) is checked per run.
      const first = args.length && typeof args[0] === 'object' && args[0] !== null && !Array.isArray(args[0]) ? args[0].key : (Array.isArray(args[0]) ? args[0][0] : args[0]);
      const key = target.key ?? first;
      if (enabled && exemptDepth === 0 && OWNED_SETTING_KEYS.has(String(key))) refuse(`settings key ${key}`);
    }
  }

  const RUNS = new Set(['run', 'get', 'all', 'iterate']);

  function guardStatement(stmt, target) {
    const proxy = new Proxy(stmt, {
      get(t, prop) {
        const value = Reflect.get(t, prop, t);
        if (typeof value !== 'function') return value;
        if (RUNS.has(prop)) return (...args) => { check(target, args); return value.apply(t, args); };
        // bind(), pluck(), raw(), safeIntegers() return the statement itself: keep the guard on it.
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
    /** Installs the guard on a better-sqlite3 database (a no-op while the switch is off). */
    install(db) {
      if ((!enabled && !samplingSettingsEnabled) || db.__rustAuthGuard) return db;
      const prepare = db.prepare.bind(db);
      const exec = db.exec.bind(db);
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

module.exports = { createRustAuthGuard, enabledFrom, writeTarget, writeTargets, OWNED_TABLES, OWNED_SETTING_KEYS };
