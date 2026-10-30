'use strict';
// Re-encrypt every stored credential under the current secrets.key (#111).
// Used by POST /api/admin/secrets/rotate and by operators from a shell:
//   UI_DATA_DIR=/path/to/ui-data node server/secrets-rotate.cjs   (or: npm run secrets:rotate)
// Every place that holds a secrets.encrypt() value is listed here; a new one belongs here too.
//
// The provider files (users/<id>/providers.json, shared-providers.json) are not listed: the Rust
// front is their only writer (sbstndalton/noevia#2190 round 6), so their keys are re-sealed by the
// front itself, in one pass per file under the file's own lock, with the current and the previous
// key (rust-providers-reseal.cjs, POST /v1/providers/reseal on the internal store). runRotation
// awaits that pass first and refuses the whole rotation when it cannot be done, so nothing else is
// changed under a half-rotated registry. This process never writes either file, and so cannot
// shift or overwrite a row the front deletes or edits meanwhile (a row-index write could).
//
// The shell form needs the front's internal store (NOEVIA_PROJECT_STORE_PORT and
// NOEVIA_PROJECT_STORE_TOKEN, which the web supervisor hands the web process alone and Node removes
// from its environment at start), so it refuses to run without them, before it changes anything,
// and says to rotate through the running app instead: POST /api/admin/secrets/rotate as an
// administrator. That keeps the front the single writer of the provider files with no second path.
const fs = require('node:fs');
const path = require('node:path');
const { resealTokenFile } = require('./gdrive.cjs');

const hasTable = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

function sqlTable(db, name, { table, keys, column, bound }) {
  return {
    name,
    rows() {
      if (!hasTable(db, table)) return [];
      return db.prepare(`SELECT ${keys.join(',')}, ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL AND ${column} != ''`).all()
        .map((r) => ({ ref: keys.map((k) => r[k]), value: r.value, userId: bound ? r.user_id : undefined }));
    },
    // Compare-and-swap on the value just read: the same plaintext under the current key, never a
    // value another writer saved meanwhile (the Rust front writes storage_connections, #2190; for
    // that table this is exactly rust-storage-connection.cjs RESEAL_SQL, the guard's one allowance).
    write(ref, value, old) {
      const changed = db.prepare(`UPDATE ${table} SET ${column}=? WHERE ${keys.map((k) => `${k}=?`).join(' AND ')} AND ${column}=?`).run(value, ...ref, old).changes;
      if (!changed) throw new Error('changed while rotating; run the rotation again');
    },
  };
}

// Members' Google Drive refresh tokens (google-drive-users/<id>.sealed) are sealed by gdrive.cjs under
// a key derived from secrets.key, not as enc: strings, so they bring their own re-seal (#866).
function googleDriveUserFiles(dir, secrets) {
  return {
    name: 'google_drive_users',
    rows() {
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir).filter((f) => f.endsWith('.sealed')).sort().map((f) => ({ ref: f, value: f }));
    },
    reseal(row) {
      const status = resealTokenFile(path.join(dir, row.ref), secrets.derive('google-drive-user'), secrets.derivePrevious('google-drive-user'));
      return { status };
    },
  };
}

function rotationTables({ db, dataDir, secrets = null }) {
  const tables = [
    sqlTable(db, 'storage_connections', { table: 'storage_connections', keys: ['user_id'], column: 'secret', bound: true }),
    sqlTable(db, 'mcp_oauth_tokens', { table: 'mcp_oauth_tokens', keys: ['user_id', 'server_id'], column: 'data_enc', bound: true }),
    sqlTable(db, 'mcp_oauth_clients', { table: 'mcp_oauth_clients', keys: ['server_id'], column: 'data_enc', bound: false }),
    sqlTable(db, 'directory_mcp_servers', { table: 'directory_mcp_servers', keys: ['id'], column: 'headers_enc', bound: false }),
    sqlTable(db, 'directory_mcp_user_keys', { table: 'directory_mcp_user_keys', keys: ['user_id', 'server_id'], column: 'headers_enc', bound: true }),
    sqlTable(db, 'chatgpt_oauth_tokens', { table: 'chatgpt_oauth_tokens', keys: ['user_id'], column: 'data_enc', bound: true }),
  ];
  if (secrets) tables.push(googleDriveUserFiles(path.join(dataDir, 'google-drive-users'), secrets));
  return tables;
}

/** Adds the front's provider pass (`{ tables, failures }`, rust-providers-reseal.cjs) to `report`. */
function mergeProviderPass(report, pass) {
  for (const [name, counts] of Object.entries(pass.tables)) {
    report.tables[name] = counts;
    for (const k of Object.keys(report.totals)) report.totals[k] += counts[k] || 0;
  }
  report.failures.push(...pass.failures);
}

/**
 * Run a rotation and record it in the audit log. Never throws for a bad row. It does throw, before
 * anything is changed, when the front cannot re-seal the provider files (`resealProviders`, awaited
 * first: rust-providers-reseal.cjs `resealProviderKeys` on the internal store).
 */
async function runRotation({ secrets, db, dataDir, audit = () => {}, actorId = null, resealProviders }) {
  if (typeof resealProviders !== 'function') throw new Error('the provider keys are re-sealed by the Rust front: runRotation needs resealProviders');
  const providers = await resealProviders();
  const report = secrets.rotate({ tables: rotationTables({ db, dataDir, secrets }) });
  mergeProviderPass(report, providers);
  report.previousKey = secrets.hasPreviousKey();
  audit('secrets.rotate', actorId, actorId, { totals: report.totals, failed: report.failures.map((f) => ({ table: f.table, ref: f.ref })).slice(0, 50) });
  return report;
}

module.exports = { rotationTables, runRotation };

if (require.main === module) {
  const store = require('./project-store-client.cjs');
  if (!store.enabledFrom(process.env, () => {})) {
    console.error('secrets rotation was not started and nothing was changed: the provider keys are re-sealed by the Rust front, which this shell cannot reach (the internal store\'s port and secret belong to the web process). Rotate through the running app instead: sign in as an administrator and POST /api/admin/secrets/rotate.');
    process.exit(2);
  }
  const resealProviders = () => require('./rust-providers-reseal.cjs').resealProviderKeys(store.clientFromEnv(process.env));
  const dataDir = process.env.UI_DATA_DIR || path.join(__dirname, 'ui-data');
  const { createSecretStore } = require('./secrets.cjs');
  const Database = require('better-sqlite3');
  const secrets = createSecretStore(dataDir);
  const db = new Database(path.join(dataDir, 'cowork.db'));
  db.pragma('busy_timeout = 5000');
  const audit = (action, actor, target, detail) => {
    if (hasTable(db, 'audit_events')) db.prepare('INSERT INTO audit_events(actor_user_id,target_user_id,action,detail,created_at) VALUES(?,?,?,?,?)').run(actor, target, action, JSON.stringify({ ...detail, via: 'cli' }), Date.now());
  };
  runRotation({ secrets, db, dataDir, audit, resealProviders }).then((report) => {
    console.log(JSON.stringify(report, null, 2));
    if (!report.previousKey) console.error('note: no previous key is configured; only legacy/plaintext values could be upgraded.');
    process.exitCode = report.totals.failed ? 2 : 0;
  }, (e) => {
    console.error(`secrets rotation stopped before any other credential was changed (the front's provider pass may have run in part; a rotation can be run again): ${String(e && e.message || e).slice(0, 300)}`);
    process.exitCode = 2;
  });
}
