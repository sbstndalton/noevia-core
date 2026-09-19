'use strict';
// MCP servers an administrator added from the public registry (Plugins → MCP servers).
//
// Kept apart from MCP_SERVERS, which the operator writes by hand: these come from strangers, so
//  - only hosted streamable-HTTP servers at a public https address are accepted (nothing runs on
//    this machine), checked again at every discovery against private networks;
//  - they never receive a user's credential; only a key an administrator typed for that server,
//    sent in the header names its registry entry declares, to that server alone;
//  - their tools are not on noevia's reviewed read-only list, so every call waits for approval;
//  - each becomes its own toolbox that a project must choose before its tools are offered.
const MAX_SERVERS = 20;
// A hosted server's address: https with no template placeholders. QA runs may also use a synthetic
// server on http://127.0.0.1 when NOEVIA_QA_ALLOW_LOOPBACK_MCP=1 (never set in deployments).
function hostedUrlOk(url) {
  const u = String(url || '');
  if (/^https:\/\/[^{}\s]+$/.test(u)) return true;
  return process.env.NOEVIA_QA_ALLOW_LOOPBACK_MCP === '1' && /^http:\/\/127\.0\.0\.1:\d+\/[^{}\s]*$/.test(u);
}


// Header values: one line, bounded. The names are the registry's own declared headers only.
function checkHeaderValues(declared, values) {
  const out = {};
  for (const h of declared) {
    let v = values && typeof values[h.name] === 'string' ? values[h.name].trim() : '';
    if (!v) { if (h.required) throw Object.assign(new Error(`Enter ${h.name}.`), { status: 400 }); continue; }
    if (v.length > 4096 || /[\r\n\0]/.test(v)) throw Object.assign(new Error(`${h.name} must be a single line under 4 KB.`), { status: 400 });
    if (h.template) v = h.template.replace(/\{[^}]+\}/, v);
    out[h.name] = v;
  }
  return out;
}

function createDirectoryMcp({ db, audit = () => {}, secrets = null }) {
  db.exec(`CREATE TABLE IF NOT EXISTS directory_mcp_servers(id TEXT PRIMARY KEY, registry_name TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL, url TEXT NOT NULL, added_by TEXT, added_at INTEGER NOT NULL);`);
  // Sign-in headers (2026-09-19): encrypted JSON {name: value}; never returned to a browser.
  if (!db.prepare("SELECT 1 FROM pragma_table_info('directory_mcp_servers') WHERE name='headers_enc'").get()) db.exec('ALTER TABLE directory_mcp_servers ADD COLUMN headers_enc TEXT');
  // OAuth servers (2026-09-19): each account signs in for itself; see mcp-oauth.cjs.
  if (!db.prepare("SELECT 1 FROM pragma_table_info('directory_mcp_servers') WHERE name='oauth'").get()) db.exec('ALTER TABLE directory_mcp_servers ADD COLUMN oauth INTEGER NOT NULL DEFAULT 0');
  const rows = () => db.prepare('SELECT id, registry_name AS registryName, title, url, added_by AS addedBy, added_at AS addedAt, headers_enc AS headersEnc, oauth FROM directory_mcp_servers ORDER BY added_at').all();
  const decode = (enc) => { if (!enc || !secrets) return {}; try { return JSON.parse(secrets.decrypt(enc)); } catch { return {}; } };
  const encode = (headers) => (Object.keys(headers).length ? (secrets ? secrets.encrypt(JSON.stringify(headers)) : (() => { throw Object.assign(new Error('Keys cannot be stored on this server.'), { status: 500 }); })()) : null);
  // Public shape: which header names hold a key, never the key.
  const list = () => rows().map(({ headersEnc, oauth, ...r }) => ({ ...r, oauth: !!oauth, keyHeaders: Object.keys(decode(headersEnc)) }));
  const idFor = (name) => `dir-${String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 34)}`;

  function add({ registryName, title, url, declaredHeaders = [], headerValues = {}, oauth = false }, actorId) {
    if (list().length >= MAX_SERVERS) throw Object.assign(new Error(`At most ${MAX_SERVERS} directory servers can be added.`), { status: 409 });
    if (!hostedUrlOk(url)) throw Object.assign(new Error('Only hosted servers at an https address can be added.'), { status: 400 });
    if (list().some((s) => s.registryName === registryName)) throw Object.assign(new Error('That server is already added.'), { status: 409 });
    const id = idFor(registryName);
    if (list().some((s) => s.id === id)) throw Object.assign(new Error('A server with a similar name is already added.'), { status: 409 });
    const headers = checkHeaderValues(declaredHeaders, headerValues);
    db.prepare('INSERT INTO directory_mcp_servers(id, registry_name, title, url, added_by, added_at, headers_enc, oauth) VALUES(?,?,?,?,?,?,?,?)').run(id, registryName, String(title || registryName).slice(0, 80), url, actorId || null, Date.now(), encode(headers), oauth ? 1 : 0);
    audit('mcp.directory.add', actorId, { registryName, url, keyHeaders: Object.keys(headers) });
    return list().find((s) => s.id === id);
  }

  function setKeys(id, declaredHeaders, headerValues, actorId) {
    if (!list().some((s) => s.id === id)) throw Object.assign(new Error('No such server.'), { status: 404 });
    const headers = checkHeaderValues(declaredHeaders, headerValues);
    db.prepare('UPDATE directory_mcp_servers SET headers_enc=? WHERE id=?').run(encode(headers), id);
    audit('mcp.directory.keys', actorId, { id, keyHeaders: Object.keys(headers) });
  }
  const headersFor = (id) => decode(rows().find((r) => r.id === id)?.headersEnc);

  function remove(id, actorId) {
    const row = list().find((s) => s.id === id);
    if (!row) throw Object.assign(new Error('No such server.'), { status: 404 });
    db.prepare('DELETE FROM directory_mcp_servers WHERE id=?').run(id);
    audit('mcp.directory.remove', actorId, { registryName: row.registryName });
    return row;
  }

  /** The servers in MCP_SERVERS shape, plus the box each one becomes once its tools are known. */
  const asServers = () => list().map((s) => ({ id: s.id, url: s.url, auth: s.oauth ? 'oauth' : s.keyHeaders.length ? 'directory' : 'none', directory: true, title: s.title, addedBy: s.addedBy }));
  const boxFor = (server, toolNames) => ({ id: server.id, server: server.id, label: server.title, directory: true,
    description: `Added from the MCP directory. Every call asks first.`, tools: [...toolNames] });

  return { list, add, remove, setKeys, headersFor, asServers, boxFor, idFor };
}

module.exports = { createDirectoryMcp, hostedUrlOk, checkHeaderValues };
