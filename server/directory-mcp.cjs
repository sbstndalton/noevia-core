'use strict';
// MCP servers an administrator added from the public registry (Plugins → MCP servers).
//
// Kept apart from MCP_SERVERS, which the operator writes by hand: these come from strangers, so
//  - only hosted streamable-HTTP servers at a public https address are accepted (nothing runs on
//    this machine), checked again at every discovery against private networks;
//  - they never receive a credential (auth is always `none`);
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


function createDirectoryMcp({ db, audit = () => {} }) {
  db.exec(`CREATE TABLE IF NOT EXISTS directory_mcp_servers(id TEXT PRIMARY KEY, registry_name TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL, url TEXT NOT NULL, added_by TEXT, added_at INTEGER NOT NULL);`);
  const list = () => db.prepare('SELECT id, registry_name AS registryName, title, url, added_by AS addedBy, added_at AS addedAt FROM directory_mcp_servers ORDER BY added_at').all();
  const idFor = (name) => `dir-${String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 34)}`;

  function add({ registryName, title, url }, actorId) {
    if (list().length >= MAX_SERVERS) throw Object.assign(new Error(`At most ${MAX_SERVERS} directory servers can be added.`), { status: 409 });
    if (!hostedUrlOk(url)) throw Object.assign(new Error('Only hosted servers at an https address can be added.'), { status: 400 });
    if (list().some((s) => s.registryName === registryName)) throw Object.assign(new Error('That server is already added.'), { status: 409 });
    const id = idFor(registryName);
    if (list().some((s) => s.id === id)) throw Object.assign(new Error('A server with a similar name is already added.'), { status: 409 });
    db.prepare('INSERT INTO directory_mcp_servers VALUES(?,?,?,?,?,?)').run(id, registryName, String(title || registryName).slice(0, 80), url, actorId || null, Date.now());
    audit('mcp.directory.add', actorId, { registryName, url });
    return list().find((s) => s.id === id);
  }

  function remove(id, actorId) {
    const row = list().find((s) => s.id === id);
    if (!row) throw Object.assign(new Error('No such server.'), { status: 404 });
    db.prepare('DELETE FROM directory_mcp_servers WHERE id=?').run(id);
    audit('mcp.directory.remove', actorId, { registryName: row.registryName });
    return row;
  }

  /** The servers in MCP_SERVERS shape, plus the box each one becomes once its tools are known. */
  const asServers = () => list().map((s) => ({ id: s.id, url: s.url, auth: 'none', directory: true, title: s.title }));
  const boxFor = (server, toolNames) => ({ id: server.id, server: server.id, label: server.title, directory: true,
    description: `Added from the MCP directory. Every call asks first.`, tools: [...toolNames] });

  return { list, add, remove, asServers, boxFor, idFor };
}

module.exports = { createDirectoryMcp, hostedUrlOk };
