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
// The MCP tables (mcp_oauth_tokens, mcp_oauth_clients, directory_mcp_user_keys and, since
// sbstndalton/noevia#2202 round 2, directory_mcp_servers.headers_enc, an administrator's shared key) are not
// listed either: the front is their only writer, so it re-seals them in one pass (each sign-in under its
// refresh lock; rust-mcp-credentials.cjs, POST /v1/mcp/reseal), awaited before the rest.
//
// The shell form needs the front's internal store (NOEVIA_PROJECT_STORE_PORT and
// NOEVIA_PROJECT_STORE_TOKEN, which the web supervisor hands the web process alone and Node removes
// from its environment at start), so it refuses to run without them, before it changes anything,
// and says to rotate through the running app instead: POST /api/admin/secrets/rotate as an
// administrator. That keeps the front the single writer of the provider files with no second path.
const fs = require('node:fs');
const path = require('node:path');
const { checkTokenFile } = require('./gdrive-seal.cjs');

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

// Members' Google Drive refresh tokens (google-drive-users/<id>.sealed) are sealed in the Rust front's format under a
// key derived from secrets.key, not as enc: strings. The front is their only writer (round 7 review): runRotation
// asks it to re-seal them first (POST /v1/gdrive/reseal, under its own fence) and this table only CHECKS, read-only,
// that every file now opens under the current key. It never writes one, so a rotation can not bring back an
// account that disconnected while it ran, nor drop a folder the front remembered.
function googleDriveUserFiles(dir, secrets) {
  return {
    name: 'google_drive_users',
    rows() {
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir).filter((f) => f.endsWith('.sealed')).sort().map((f) => ({ ref: f, value: f }));
    },
    reseal(row) {
      return { status: checkTokenFile(path.join(dir, row.ref), secrets.derive('google-drive-user')) };
    },
  };
}

function rotationTables({ db, dataDir, secrets = null }) {
  const tables = [
    sqlTable(db, 'storage_connections', { table: 'storage_connections', keys: ['user_id'], column: 'secret', bound: true }),
    sqlTable(db, 'chatgpt_oauth_tokens', { table: 'chatgpt_oauth_tokens', keys: ['user_id'], column: 'data_enc', bound: true }),
  ];
  if (secrets) tables.push(googleDriveUserFiles(path.join(dataDir, 'google-drive-users'), secrets));
  return tables;
}

/** Adds a front pass (`{ tables, failures }`: the providers' or the MCP credentials') to `report`. */
function mergeProviderPass(report, pass) {
  for (const [name, counts] of Object.entries(pass.tables)) {
    report.tables[name] = counts;
    for (const k of Object.keys(report.totals)) report.totals[k] += counts[k] || 0;
  }
  report.failures.push(...pass.failures);
}

/**
 * The Rust front re-seals the Google Drive token files (it is their only writer) before the rest is
 * rotated. `gdriveReseal` is the broker call (`project-store-client` gdriveReseal): `{ ok, counts }` or
 * `{ ok: false, ... }`. A front that cannot do it (down, an older build) is a failure of that table, recorded
 * in the report: the files are left as they were, still readable by the front under the retired key, so the
 * operator must keep the previous key and run the rotation again.
 */
async function resealGoogleDrive(gdriveReseal) {
  if (!gdriveReseal) return { error: 'the Rust front was not asked to re-seal the Google Drive token files (run the rotation from the admin page of the running server)' };
  try {
    const r = await gdriveReseal();
    if (r && r.ok) return { counts: r.counts };
    return { error: `the Rust front could not re-seal the Google Drive token files (${(r && r.status) || 'unreachable'})` };
  } catch { return { error: 'the Rust front could not re-seal the Google Drive token files (unreachable)' }; }
}

/**
 * Run a rotation and record it in the audit log. Never throws for a bad row. The order is fixed, and every
 * callback is checked before the first await (a missing one must not leave the first passes done):
 *   1. `await resealProviders()`: the front re-seals the provider files (rust-providers-reseal.cjs
 *      `resealProviderKeys`). It throws when it cannot, and then nothing below runs.
 *   2. `await resealMcp()`: the front re-seals the MCP sign-ins, apps and keys (rust-mcp-credentials.cjs
 *      `resealMcpCredentials`). It throws too, and then nothing below runs.
 *   3. `await gdriveReseal()`: the front re-seals the Google Drive token files (SOFT: a front that cannot do
 *      it is a failure of that table in the report, and the rotation goes on).
 *   4. `secrets.rotate`: the rest, in this process.
 *   5. the passes are merged into the report and the Drive check is relabelled.
 * Steps 1 and 2 throw when the front cannot do them, and then THIS process has changed nothing. The front's own
 * passes may have run in part (the providers' before a failing MCP pass, or some rows of one): each re-seal is
 * idempotent and per row, so a rotation can simply be run again.
 */
async function runRotation({ secrets, db, dataDir, audit = () => {}, actorId = null, resealProviders, resealMcp, gdriveReseal = null }) {
  if (typeof resealProviders !== 'function') throw new Error('the provider keys are re-sealed by the Rust front: runRotation needs resealProviders');
  if (typeof resealMcp !== 'function') throw new Error('the MCP credentials are re-sealed by the Rust front: runRotation needs resealMcp');
  if (gdriveReseal !== null && gdriveReseal !== undefined && typeof gdriveReseal !== 'function') throw new Error('gdriveReseal, when given, must be a function');
  const providers = await resealProviders();
  const mcpCredentials = await resealMcp();
  // Awaited too: the front's re-seal is a step of the rotation, not a race with it.
  const front = await resealGoogleDrive(gdriveReseal);
  const report = secrets.rotate({ tables: rotationTables({ db, dataDir, secrets }) });
  mergeProviderPass(report, providers);
  mergeProviderPass(report, mcpCredentials);
  if (report.tables.google_drive_users) {
    const t = report.tables.google_drive_users;
    if (front.counts) {
      // The files the front re-sealed were 'current' when this check read them; they are reported as rotated.
      const moved = Math.min(front.counts.rotated || 0, t.current);
      t.current -= moved; t.rotated += moved; report.totals.current -= moved; report.totals.rotated += moved;
    } else if (t.failed > 0) {
      // Files the check could not open and a front that did not re-seal them: say why (the files are the count).
      report.failures.push({ table: 'google_drive_users', ref: null, error: front.error });
    }
  }
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
  // ONE store client, and every re-seal it offers, as the admin route passes them (index.cjs).
  const front = store.clientFromEnv(process.env);
  const resealProviders = () => require('./rust-providers-reseal.cjs').resealProviderKeys(front);
  const resealMcp = () => require('./rust-mcp-credentials.cjs').resealMcpCredentials(front);
  const gdriveReseal = () => front.gdriveReseal();
  const dataDir = process.env.UI_DATA_DIR || path.join(__dirname, 'ui-data');
  const { createSecretStore } = require('./secrets.cjs');
  const Database = require('better-sqlite3');
  const secrets = createSecretStore(dataDir);
  const db = new Database(path.join(dataDir, 'cowork.db'));
  db.pragma('busy_timeout = 5000');
  const audit = (action, actor, target, detail) => {
    if (hasTable(db, 'audit_events')) db.prepare('INSERT INTO audit_events(actor_user_id,target_user_id,action,detail,created_at) VALUES(?,?,?,?,?)').run(actor, target, action, JSON.stringify({ ...detail, via: 'cli' }), Date.now());
  };
  runRotation({ secrets, db, dataDir, audit, resealProviders, resealMcp, gdriveReseal }).then((report) => {
    console.log(JSON.stringify(report, null, 2));
    if (!report.previousKey) console.error('note: no previous key is configured; only legacy/plaintext values could be upgraded.');
    process.exitCode = report.totals.failed ? 2 : 0;
  }, (e) => {
    console.error(`secrets rotation stopped before this process changed any credential (the front's passes may have run in part; a rotation can be run again): ${String(e && e.message || e).slice(0, 300)}`);
    process.exitCode = 2;
  });
}
