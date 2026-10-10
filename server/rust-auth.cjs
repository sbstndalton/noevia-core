'use strict';
// The cross-runtime single-writer guard for M3 of the full-Rust migration (noevia
// docs/adr-0001-rust-and-repo-split.md, "Amendment 2026-10-10"): once the deployment switch is on,
// the Rust front (noevia-rs bins/noevia-server) owns sign-in and the account routes and the tables
// they write, and this process refuses to write them, so every owned row has one writer.
//
// The switch is NOEVIA_RUST_AUTH=1 (exactly) together with NOEVIA_FRONT=rust: the front only
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

const WRITE_RE = /^\s*(?:INSERT(?:\s+OR\s+[A-Za-z]+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+[A-Za-z]+)?|DELETE\s+FROM)\s+["`[]?([A-Za-z_][A-Za-z0-9_]*)/i;
const SETTING_KEY_RE = /\bkey\s*=\s*'([^']*)'|VALUES\s*\(\s*'([^']*)'/i;

/** Whether the switch is on for this process (see the header). */
function enabledFrom(env = process.env, warn = console.warn) {
  if (env.NOEVIA_RUST_AUTH !== '1') return false;
  if (env.NOEVIA_FRONT !== 'rust') {
    warn('NOEVIA_RUST_AUTH=1 is ignored: the Rust front answers sign-in only with NOEVIA_FRONT=rust.');
    return false;
  }
  return true;
}

/** The table one SQL statement writes, and the settings key it names literally, or null. */
function writeTarget(sql) {
  const m = WRITE_RE.exec(String(sql));
  if (!m) return null;
  const table = m[1].toLowerCase();
  if (table !== 'settings') return { table, key: null };
  const k = SETTING_KEY_RE.exec(String(sql));
  return { table, key: k ? (k[1] ?? k[2]) : null };
}

/** The statements of a db.exec() script (no quoted ';' occurs in this codebase's scripts). */
function statements(sql) {
  return String(sql).split(';').map((s) => s.trim()).filter(Boolean);
}

function createRustAuthGuard({ enabled = false } = {}) {
  let exemptDepth = 0;

  function refuse(what) {
    throw Object.assign(new Error(`${what} is written by the Rust front while NOEVIA_RUST_AUTH is on`), { status: 503, code: 'RUST_AUTH_OWNED' });
  }

  /** Throws when running `target` (with `args`) would write what Rust owns. */
  function check(target, args) {
    if (!enabled || exemptDepth > 0 || !target) return;
    if (OWNED_TABLES.has(target.table)) refuse(target.table);
    if (target.table === 'settings') {
      // A key bound as the first parameter (features.cjs settingsStore.set) is checked per run.
      const first = args.length && typeof args[0] === 'object' && args[0] !== null && !Array.isArray(args[0]) ? args[0].key : (Array.isArray(args[0]) ? args[0][0] : args[0]);
      const key = target.key ?? first;
      if (OWNED_SETTING_KEYS.has(String(key))) refuse(`settings key ${key}`);
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
      if (!enabled || db.__rustAuthGuard) return db;
      const prepare = db.prepare.bind(db);
      const exec = db.exec.bind(db);
      db.prepare = (sql, ...rest) => {
        const stmt = prepare(sql, ...rest);
        const target = writeTarget(sql);
        return target ? guardStatement(stmt, target) : stmt;
      };
      db.exec = (sql) => {
        for (const s of statements(sql)) check(writeTarget(s), []);
        return exec(sql);
      };
      Object.defineProperty(db, '__rustAuthGuard', { value: true });
      return db;
    },
  };
}

module.exports = { createRustAuthGuard, enabledFrom, writeTarget, OWNED_TABLES, OWNED_SETTING_KEYS };
