'use strict';
// MCP servers an administrator added from the public registry or by address (Plugins -> MCP servers),
// as this process's chat-time MCP client needs them.
//
// Kept apart from MCP_SERVERS, which the operator writes by hand: these come from strangers, so
//  - only hosted streamable-HTTP servers at a public https address are accepted (nothing runs on
//    this machine), checked again at every discovery against private networks;
//  - they never receive a user's credential; only a key an administrator typed for that server,
//    sent in the header names its registry entry declares, to that server alone;
//  - their tools are not on noevia's reviewed read-only list, so every call waits for approval;
//  - each becomes its own toolbox that a project must choose before its tools are offered.
//
// The table (directory_mcp_servers) is the Rust front's since sbstndalton/noevia#2202 round 2
// (rust-mcp-directory.cjs): it lists a candidate server's tools, adds, re-keys and removes servers and
// is the only writer (rust-auth.cjs FRONT_TABLES refuses every write from here). This module reads it:
// the list is re-read through shared-reread.cjs createReread on a change signal (the table's content),
// so a server the front adds shows up on the next use without a restart, and a table that cannot be
// read means NO directory servers (fails closed), never the last list. A shared key (headers_enc) is
// opened only when a discovery or a call asks for it, and is never part of the list.
const { createReread } = require('./shared-reread.cjs');

// A hosted server's address: https with no template placeholders. QA runs may also use a synthetic
// server on http://127.0.0.1 when NOEVIA_QA_ALLOW_LOOPBACK_MCP=1 (never set in deployments).
function hostedUrlOk(url) {
  const u = String(url || '');
  if (/^https:\/\/[^{}\s]+$/.test(u)) return true;
  return process.env.NOEVIA_QA_ALLOW_LOOPBACK_MCP === '1' && /^http:\/\/127\.0\.0\.1:\d+\/[^{}\s]*$/.test(u);
}

/** Node is the schema migrator: the table exists, with every column, whichever process writes it. */
function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS directory_mcp_servers(id TEXT PRIMARY KEY, registry_name TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL, url TEXT NOT NULL, added_by TEXT, added_at INTEGER NOT NULL);`);
  // Sign-in headers (2026-09-19): encrypted JSON {name: value}; never returned to a browser.
  if (!db.prepare("SELECT 1 FROM pragma_table_info('directory_mcp_servers') WHERE name='headers_enc'").get()) db.exec('ALTER TABLE directory_mcp_servers ADD COLUMN headers_enc TEXT');
  // OAuth servers (2026-09-19): each account signs in for itself (the front is the broker).
  if (!db.prepare("SELECT 1 FROM pragma_table_info('directory_mcp_servers') WHERE name='oauth'").get()) db.exec('ALTER TABLE directory_mcp_servers ADD COLUMN oauth INTEGER NOT NULL DEFAULT 0');
  // Per-account keys (2026-09-19): `personal` servers take each account's own key; the declared
  // header list (names, hints, templates - no values) is kept so the key form needs no registry.
  if (!db.prepare("SELECT 1 FROM pragma_table_info('directory_mcp_servers') WHERE name='personal'").get()) db.exec("ALTER TABLE directory_mcp_servers ADD COLUMN personal INTEGER NOT NULL DEFAULT 0; ALTER TABLE directory_mcp_servers ADD COLUMN declared_json TEXT NOT NULL DEFAULT '[]'");
}

const COLUMNS = 'id, registry_name AS registryName, title, url, added_by AS addedBy, added_at AS addedAt, headers_enc AS headersEnc, oauth, personal, declared_json AS declaredJson';

/**
 * @param {object} o
 * @param {object} o.db            the shared database (read here; the front writes)
 * @param {object|null} [o.secrets] secretStore, to open a shared key
 */
function createDirectoryMcp({ db, secrets = null }) {
  migrate(db);
  const statement = db.prepare(`SELECT ${COLUMNS} FROM directory_mcp_servers ORDER BY added_at, rowid`);
  /** The table's rows as one string: it changes exactly when a row, a flag or a sealed key does. */
  const rawSignal = () => JSON.stringify(statement.all());

  const parse = (j) => { try { const v = JSON.parse(j); return Array.isArray(v) ? v : []; } catch { return []; } };
  // A shared server's key has no owning user (decode with no userId, v1). The front seals it unbound.
  const decode = (enc) => { if (!enc || !secrets) return {}; try { return JSON.parse(secrets.decrypt(enc)); } catch { return {}; } };

  const reread = createReread({
    signal: rawSignal,
    load: (token) => JSON.parse(token).map(({ headersEnc, oauth, personal, declaredJson, ...r }) => ({
      ...r, oauth: !!oauth, personal: !!personal, declaredHeaders: parse(declaredJson), keyHeaders: Object.keys(decode(headersEnc)), headersEnc: headersEnc || null,
    })),
    fallback: () => [],
  });

  /** The servers as the admin page lists them (no key): `[]` while the table cannot be read. */
  const list = () => reread.current().map(({ headersEnc, ...r }) => r);
  /** A change signal for the list: differs when the table does, 'unreadable' while it cannot be read. */
  const signal = () => { try { return rawSignal(); } catch { return 'unreadable'; } };
  const headersFor = (id) => decode(reread.current().find((r) => r.id === id)?.headersEnc);
  const idFor = (name) => `dir-${String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 34)}`;

  /** The servers in MCP_SERVERS shape, plus the box each one becomes once its tools are known. */
  const asServers = () => list().map((s) => ({ id: s.id, url: s.url, auth: s.oauth ? 'oauth' : s.personal ? 'personal' : s.keyHeaders.length ? 'directory' : 'none', directory: true, title: s.title, addedBy: s.addedBy }));
  const boxFor = (server, toolNames) => ({ id: server.id, server: server.id, label: server.title, directory: true,
    description: `Added from the MCP directory. Every call asks first.`, tools: [...toolNames] });

  return { list, signal, headersFor, asServers, boxFor, idFor };
}

module.exports = { createDirectoryMcp, hostedUrlOk, migrate };
