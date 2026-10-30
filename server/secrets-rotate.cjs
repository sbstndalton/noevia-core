'use strict';
// Re-encrypt every stored credential under the current secrets.key (#111).
// Used by POST /api/admin/secrets/rotate and by operators from a shell:
//   UI_DATA_DIR=/path/to/ui-data node server/secrets-rotate.cjs   (or: npm run secrets:rotate)
// Every place that holds a secrets.encrypt() value is listed here; a new one belongs here too.
const fs = require('node:fs');
const path = require('node:path');
const { atomicJson } = require('./workspace.cjs');
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

// Provider keys in JSON files are unbound (workspace.cjs decrypts them without a userId).
function providerFile(name, file) {
  return {
    name,
    rows() {
      if (!fs.existsSync(file)) return [];
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      return (data.providers || []).map((p, i) => ({ ref: i, value: p.apiKey })).filter((r) => r.value);
    },
    write(index, value) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      data.providers[index].apiKey = value;
      atomicJson(file, data);
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
    sqlTable(db, 'mcp_oauth_tokens', { table: 'mcp_oauth_tokens', keys: ['user_id', 'server_id'], column: 'data_enc', bound: true }),
    sqlTable(db, 'mcp_oauth_clients', { table: 'mcp_oauth_clients', keys: ['server_id'], column: 'data_enc', bound: false }),
    sqlTable(db, 'directory_mcp_servers', { table: 'directory_mcp_servers', keys: ['id'], column: 'headers_enc', bound: false }),
    sqlTable(db, 'directory_mcp_user_keys', { table: 'directory_mcp_user_keys', keys: ['user_id', 'server_id'], column: 'headers_enc', bound: true }),
    sqlTable(db, 'chatgpt_oauth_tokens', { table: 'chatgpt_oauth_tokens', keys: ['user_id'], column: 'data_enc', bound: true }),
    providerFile('shared_providers', path.join(dataDir, 'shared-providers.json')),
  ];
  if (secrets) tables.push(googleDriveUserFiles(path.join(dataDir, 'google-drive-users'), secrets));
  const usersDir = path.join(dataDir, 'users');
  if (fs.existsSync(usersDir)) {
    for (const id of fs.readdirSync(usersDir).sort()) {
      const file = path.join(usersDir, id, 'providers.json');
      if (fs.existsSync(file)) tables.push(providerFile(`user_providers:${id}`, file));
    }
  }
  return tables;
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

/** Run a rotation and record it in the audit log. Never throws for a bad row. */
async function runRotation({ secrets, db, dataDir, audit = () => {}, actorId = null, gdriveReseal = null }) {
  // Before anything else, and awaited: the front's re-seal is a step of the rotation, not a race with it.
  const front = await resealGoogleDrive(gdriveReseal);
  const report = secrets.rotate({ tables: rotationTables({ db, dataDir, secrets }) });
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
  const dataDir = process.env.UI_DATA_DIR || path.join(__dirname, 'ui-data');
  const { createSecretStore } = require('./secrets.cjs');
  const Database = require('better-sqlite3');
  const secrets = createSecretStore(dataDir);
  const db = new Database(path.join(dataDir, 'cowork.db'));
  db.pragma('busy_timeout = 5000');
  const audit = (action, actor, target, detail) => {
    if (hasTable(db, 'audit_events')) db.prepare('INSERT INTO audit_events(actor_user_id,target_user_id,action,detail,created_at) VALUES(?,?,?,?,?)').run(actor, target, action, JSON.stringify({ ...detail, via: 'cli' }), Date.now());
  };
  // The Rust front owns the Google Drive token files and re-seals them through the running server; a shell has no
  // route to it, so those files are only checked here (and reported as failed while they are still under the old key).
  runRotation({ secrets, db, dataDir, audit }).then((report) => {
    console.log(JSON.stringify(report, null, 2));
    if (!report.previousKey) console.error('note: no previous key is configured; only legacy/plaintext values could be upgraded.');
    if (report.failures.some((f) => f.table === 'google_drive_users')) console.error('note: the Google Drive token files are re-sealed by the running server: use Settings -> Security -> rotate (POST /api/admin/secrets/rotate).');
    process.exitCode = report.totals.failed ? 2 : 0;
  });
}
