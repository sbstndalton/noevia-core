'use strict';
// Re-encrypt every stored credential under the current secrets.key (#111).
// Used by POST /api/admin/secrets/rotate and by operators from a shell:
//   UI_DATA_DIR=/path/to/ui-data node server/secrets-rotate.cjs   (or: npm run secrets:rotate)
// Every place that holds a secrets.encrypt() value is listed here; a new one belongs here too.
const fs = require('node:fs');
const path = require('node:path');
const { atomicJson } = require('./workspace.cjs');

const hasTable = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

function sqlTable(db, name, { table, keys, column, bound }) {
  return {
    name,
    rows() {
      if (!hasTable(db, table)) return [];
      return db.prepare(`SELECT ${keys.join(',')}, ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL AND ${column} != ''`).all()
        .map((r) => ({ ref: keys.map((k) => r[k]), value: r.value, userId: bound ? r.user_id : undefined }));
    },
    write(ref, value) {
      db.prepare(`UPDATE ${table} SET ${column}=? WHERE ${keys.map((k) => `${k}=?`).join(' AND ')}`).run(value, ...ref);
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

function rotationTables({ db, dataDir }) {
  const tables = [
    sqlTable(db, 'storage_connections', { table: 'storage_connections', keys: ['user_id'], column: 'secret', bound: true }),
    sqlTable(db, 'mcp_oauth_tokens', { table: 'mcp_oauth_tokens', keys: ['user_id', 'server_id'], column: 'data_enc', bound: true }),
    sqlTable(db, 'mcp_oauth_clients', { table: 'mcp_oauth_clients', keys: ['server_id'], column: 'data_enc', bound: false }),
    sqlTable(db, 'directory_mcp_servers', { table: 'directory_mcp_servers', keys: ['id'], column: 'headers_enc', bound: false }),
    sqlTable(db, 'directory_mcp_user_keys', { table: 'directory_mcp_user_keys', keys: ['user_id', 'server_id'], column: 'headers_enc', bound: true }),
    providerFile('shared_providers', path.join(dataDir, 'shared-providers.json')),
  ];
  const usersDir = path.join(dataDir, 'users');
  if (fs.existsSync(usersDir)) {
    for (const id of fs.readdirSync(usersDir).sort()) {
      const file = path.join(usersDir, id, 'providers.json');
      if (fs.existsSync(file)) tables.push(providerFile(`user_providers:${id}`, file));
    }
  }
  return tables;
}

/** Run a rotation and record it in the audit log. Never throws for a bad row. */
function runRotation({ secrets, db, dataDir, audit = () => {}, actorId = null }) {
  const report = secrets.rotate({ tables: rotationTables({ db, dataDir }) });
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
  const report = runRotation({ secrets, db, dataDir, audit });
  console.log(JSON.stringify(report, null, 2));
  if (!report.previousKey) console.error('note: no previous key is configured; only legacy/plaintext values could be upgraded.');
  process.exitCode = report.totals.failed ? 2 : 0;
}
