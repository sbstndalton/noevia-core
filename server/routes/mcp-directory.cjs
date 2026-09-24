'use strict';
// MCP servers that were added from the Plugins page, and each account's own sign-in or key.
//   GET    /api/mcp-keys/servers                       servers whose key each person supplies
//   PUT    /api/mcp-keys/:id  { headers }              store this account's key (checked first)
//   DELETE /api/mcp-keys/:id
//   GET    /api/mcp-oauth/servers                      sign-in servers and whether this account is connected
//   POST   /api/mcp-oauth/:id/connect                  begin this account's sign-in
//   DELETE /api/mcp-oauth/:id
//   GET    /api/mcp-oauth/callback                     the sign-in service's return address
//   GET/POST /api/admin/mcp-directory                  admin: list / add a registry server
//   POST   /api/admin/mcp-directory/custom             admin: add any server by URL
//   PUT    /api/admin/mcp-directory/:id/keys           admin: replace a shared key
//   PUT    /api/admin/mcp-directory/:id/oauth-client   admin: hand-registered app
//   DELETE /api/admin/mcp-directory/:id
// Returns true when it handled the request. Discovery and the directory state stay in
// index.cjs and are injected; `servers` is the live MCP_SERVERS array (mutated in place by
// `syncDirectoryServers`), never a copy.
function createMcpDirectoryRoutes({ json, readJson, auth, servers: MCP_SERVERS, mcpState, directoryMcp, mcpOAuth, discoverOneServer, discoverMcpTools, probeMcpAuth, syncDirectoryServers, directoryUrlAllowed }) {
  const reply = (res, code, body) => (json(res, code, body), true);
  return async function mcpDirectoryRoutes(req, res, { path: p, authn }) {
    // Per-account keys for directory servers the admin set to "each person uses their own key".
    if (authn && p === '/api/mcp-keys/servers' && req.method === 'GET') {
      return reply(res, 200, { servers: directoryMcp.list().filter((s) => s.personal).map((s) => ({ id: s.id, title: s.title, headers: s.declaredHeaders, hasKey: directoryMcp.hasUserKey(authn.user.id, s.id) })) });
    }
    const userKey = p.match(/^\/api\/mcp-keys\/([a-z0-9-]+)$/);
    if (authn && userKey && req.method === 'PUT') {
      const row = directoryMcp.list().find((s) => s.id === userKey[1] && s.personal);
      if (!row) return reply(res, 404, { error: 'No such server.' });
      let body; try { body = await readJson(req); } catch { return reply(res, 400, { error: 'invalid JSON' }); }
      let pendingHeaders;
      try { pendingHeaders = require('../directory-mcp.cjs').checkHeaderValues(row.declaredHeaders, body?.headers || {}); } catch (e) { return reply(res, e.status || 400, { error: e.message }); }
      try { await discoverOneServer({ id: row.id, url: row.url, auth: 'directory', directory: true, pendingHeaders }); }
      catch (e) { return reply(res, 422, { error: `The server did not accept that key: ${String(e.message || e).slice(0, 200)}` }); }
      try { directoryMcp.setUserKey(authn.user.id, row.id, body?.headers || {}); } catch (e) { return reply(res, e.status || 400, { error: e.message }); }
      return reply(res, 200, { ok: true });
    }
    if (authn && userKey && req.method === 'DELETE') { directoryMcp.clearUserKey(authn.user.id, userKey[1]); return reply(res, 200, { ok: true }); }
    // Per-account OAuth sign-in to directory servers (any signed-in account, each for itself).
    if (authn && p === '/api/mcp-oauth/servers' && req.method === 'GET') {
      return reply(res, 200, { servers: MCP_SERVERS.filter((sv) => sv.auth === 'oauth').map((sv) => { const state = mcpOAuth.status ? mcpOAuth.status(authn.user.id, sv.id) : (mcpOAuth.connected(authn.user.id, sv.id) ? 'connected' : 'disconnected'); return { id: sv.id, title: sv.title, connected: state === 'connected', needsReauth: state === 'needs-reauth' }; }) });
    }
    const oauthConnect = p.match(/^\/api\/mcp-oauth\/([a-z0-9-]+)\/connect$/);
    if (authn && oauthConnect && req.method === 'POST') {
      const sv = MCP_SERVERS.find((x) => x.id === oauthConnect[1] && x.auth === 'oauth');
      if (!sv) return reply(res, 404, { error: 'No such sign-in server.' });
      try { return reply(res, 200, { signIn: await mcpOAuth.start({ userId: authn.user.id, serverId: sv.id, serverUrl: sv.url, challenge: (await probeMcpAuth(sv.url)).challenge }) }); }
      catch (e) { return reply(res, e.status || 502, { error: e.needsClient ? 'An administrator has to finish setting this server up before anyone can sign in.' : e.message }); }
    }
    const oauthDrop = p.match(/^\/api\/mcp-oauth\/([a-z0-9-]+)$/);
    if (authn && oauthDrop && req.method === 'DELETE') { mcpOAuth.disconnect(authn.user.id, oauthDrop[1]); return reply(res, 200, { ok: true }); }
    if (authn && p === '/api/mcp-oauth/callback' && req.method === 'GET') {
      const q = new URL(req.url, 'http://local').searchParams;
      const page = (ok, text) => { res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" });
        res.end(`<!doctype html><meta name=viewport content="width=device-width"><title>noevia sign-in</title><body style="font:16px system-ui;padding:32px;max-width:32em"><h1 style="font-size:20px">${ok ? 'Signed in' : 'Sign-in did not finish'}</h1><p>${String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))}</p><p>You can close this tab and return to noevia.</p><script>setTimeout(()=>{try{window.close()}catch{}},1200)</script>`), true; };
      if (q.get('error')) return page(false, `The sign-in service said: ${String(q.get('error_description') || q.get('error')).slice(0, 200)}`);
      try {
        const done = await mcpOAuth.finish({ userId: authn.user.id, state: q.get('state'), code: q.get('code') });
        await discoverMcpTools(true); // an admin's (re-)sign-in may be what the tool list was waiting for
        return page(true, done.purpose === 'add' ? 'The server is added. Choose it under a project’s Tools; each person signs in from Plugins → Connected.' : 'Your account is connected. Its tools are now offered in projects that chose this server.');
      } catch (e) { return page(false, e.message); }
    }
    // Plugins → MCP servers → Add: administrators only; the URL comes from the registry, not the client.
    if (p === '/api/admin/mcp-directory' || p.startsWith('/api/admin/mcp-directory/')) {
      if (!authn || authn.user.role !== 'admin') return reply(res, 403, { error: 'Administrator required' });
      const redirectUri = `${String(auth.origin || process.env.PUBLIC_ORIGIN || '').replace(/\/$/, '')}/api/mcp-oauth/callback`;
      const describe = () => directoryMcp.list().map((s) => { const st = mcpState.servers.get(s.id); return { ...s, toolCount: st?.toolCount ?? null, error: st?.error || null, ...(s.oauth ? { oauthClient: mcpOAuth.clientInfo(s.id), redirectUri } : {}) }; });
      if (p === '/api/admin/mcp-directory' && req.method === 'GET') return reply(res, 200, { servers: describe() });
      if (p === '/api/admin/mcp-directory' && req.method === 'POST') {
        let body; try { body = await readJson(req); } catch { return reply(res, 400, { error: 'invalid JSON' }); }
        let item;
        try { item = await require('./plugin-directory.cjs').findRegistryServer(body?.registryName); } catch (e) { return reply(res, e.status || 502, { error: e.message }); }
        if (!item) return reply(res, 404, { error: 'That server is not in the MCP registry.' });
        if (!item.installable) return reply(res, 422, { error: item.notInstallable || 'That server cannot be added.' });
        if (!(await directoryUrlAllowed(item.remoteUrl))) return reply(res, 422, { error: 'That server’s address is not a public host.' });
        // Prove it answers before saving: an entry that cannot list tools would only be a dead box.
        let found;
        let pendingHeaders;
        try { pendingHeaders = require('../directory-mcp.cjs').checkHeaderValues(item.headers || [], body.headers || {}); } catch (e) { return reply(res, e.status || 400, { error: e.message }); }
        const hasKey = Object.keys(pendingHeaders).length > 0;
        try { found = await discoverOneServer({ id: directoryMcp.idFor(item.id), url: item.remoteUrl, auth: hasKey ? 'directory' : 'none', directory: true, pendingHeaders }); }
        catch (e) {
          // No key and the server asks for sign-in: add it as an OAuth server and send the admin to sign in.
          const probe = !hasKey ? await probeMcpAuth(item.remoteUrl) : { status: 0 };
          if (probe.status === 401) {
            let added;
            try { added = directoryMcp.add({ registryName: item.id, title: item.name, url: item.remoteUrl, oauth: true }, authn.user.id); } catch (err) { return reply(res, err.status || 400, { error: err.message }); }
            syncDirectoryServers();
            try {
              const signIn = await mcpOAuth.start({ userId: authn.user.id, serverId: added.id, serverUrl: item.remoteUrl, challenge: probe.challenge, purpose: 'add' });
              return reply(res, 202, { signIn, server: added, servers: describe() });
            } catch (err) {
              // The service needs an app registered by hand: keep the server and ask for the app.
              if (err.needsClient) return reply(res, 202, { needsClient: true, issuer: err.issuer, redirectUri, server: added, servers: describe() });
              directoryMcp.remove(added.id, authn.user.id); mcpOAuth.forget(added.id); syncDirectoryServers();
              return reply(res, 422, { error: `The server needs a sign-in noevia cannot do: ${err.message}` });
            }
          } return reply(res, 422, { error: `${hasKey ? 'The server did not accept that key, or' : 'The server'} did not answer as an MCP server: ${String(e.message || e).slice(0, 200)}` }); }
        if (!found.size) return reply(res, 422, { error: 'The server answered but offers no tools noevia can use.' });
        let added;
        try { added = directoryMcp.add({ registryName: item.id, title: item.name, url: item.remoteUrl, declaredHeaders: item.headers || [], headerValues: body.headers || {}, personal: hasKey && body.keyMode === 'personal' }, authn.user.id); } catch (e) { return reply(res, e.status || 400, { error: e.message }); }
        syncDirectoryServers();
        await discoverMcpTools(true);
        return reply(res, 201, { server: { ...added, toolCount: found.size }, servers: describe() });
      }
      // Change a server's key: checked against the server before it replaces the old one.
      const keys = p.match(/^\/api\/admin\/mcp-directory\/([a-z0-9-]+)\/keys$/);
      if (keys && req.method === 'PUT') {
        const row = directoryMcp.list().find((s) => s.id === keys[1]);
        if (!row) return reply(res, 404, { error: 'No such server.' });
        let body; try { body = await readJson(req); } catch { return reply(res, 400, { error: 'invalid JSON' }); }
        let item;
        try { item = await require('./plugin-directory.cjs').findRegistryServer(row.registryName); } catch (e) { return reply(res, e.status || 502, { error: e.message }); }
        const declared = item?.headers || [];
        let pendingHeaders;
        try { pendingHeaders = require('../directory-mcp.cjs').checkHeaderValues(declared, body.headers || {}); } catch (e) { return reply(res, e.status || 400, { error: e.message }); }
        try { await discoverOneServer({ id: row.id, url: row.url, auth: 'directory', directory: true, pendingHeaders }); }
        catch (e) { return reply(res, 422, { error: `The server did not accept that key: ${String(e.message || e).slice(0, 200)}` }); }
        try { directoryMcp.setKeys(row.id, declared, body.headers || {}, authn.user.id); } catch (e) { return reply(res, e.status || 400, { error: e.message }); }
        syncDirectoryServers();
        await discoverMcpTools(true);
        return reply(res, 200, { servers: describe() });
      }
      // Add any MCP server by its URL (roadmap: Customize backends). Same rules as a directory
      // server: hosted https, public address, must answer, its own toolbox, every tool asks.
      if (p === '/api/admin/mcp-directory/custom' && req.method === 'POST') {
        let body; try { body = await readJson(req); } catch { return reply(res, 400, { error: 'invalid JSON' }); }
        const title = String(body?.title || '').trim().slice(0, 80);
        const url = String(body?.url || '').trim();
        if (!title) return reply(res, 400, { error: 'Give the server a name.' });
        if (!require('../directory-mcp.cjs').hostedUrlOk(url)) return reply(res, 400, { error: 'The address must be an https URL (no placeholders).' });
        if (!(await directoryUrlAllowed(url))) return reply(res, 422, { error: 'That address is not a public host.' });
        const headerName = String(body?.headerName || '').trim();
        const headerValue = String(body?.headerValue || '');
        if (headerName && (!/^[A-Za-z0-9-]{1,64}$/.test(headerName) || require('./plugin-directory.cjs').RESERVED_HEADERS.test(headerName))) {
          return reply(res, 400, { error: `${headerName} cannot be used as a sign-in header.` });
        }
        const declaredHeaders = headerName ? [{ name: headerName, required: true, secret: true, description: '', template: null }] : [];
        let pendingHeaders;
        try { pendingHeaders = require('../directory-mcp.cjs').checkHeaderValues(declaredHeaders, headerName ? { [headerName]: headerValue } : {}); } catch (e) { return reply(res, e.status || 400, { error: e.message }); }
        const hasKey = Object.keys(pendingHeaders).length > 0;
        const registryName = `url:${url}`;
        let found;
        try { found = await discoverOneServer({ id: directoryMcp.idFor(registryName), url, auth: hasKey ? 'directory' : 'none', directory: true, pendingHeaders }); }
        catch (e) {
          const probe = !hasKey ? await probeMcpAuth(url) : { status: 0 };
          if (probe.status === 401) {
            let added;
            try { added = directoryMcp.add({ registryName, title, url, oauth: true }, authn.user.id); } catch (err) { return reply(res, err.status || 400, { error: err.message }); }
            syncDirectoryServers();
            try {
              const signIn = await mcpOAuth.start({ userId: authn.user.id, serverId: added.id, serverUrl: url, challenge: probe.challenge, purpose: 'add' });
              return reply(res, 202, { signIn, server: added, servers: describe() });
            } catch (err) {
              if (err.needsClient) return reply(res, 202, { needsClient: true, issuer: err.issuer, redirectUri, server: added, servers: describe() });
              directoryMcp.remove(added.id, authn.user.id); mcpOAuth.forget(added.id); syncDirectoryServers();
              return reply(res, 422, { error: `The server needs a sign-in noevia cannot do: ${err.message}` });
            }
          }
          return reply(res, 422, { error: `${hasKey ? 'The server did not accept that key, or' : 'The server'} did not answer as an MCP server: ${String(e.message || e).slice(0, 200)}` });
        }
        if (!found.size) return reply(res, 422, { error: 'The server answered but offers no tools noevia can use.' });
        let added;
        try { added = directoryMcp.add({ registryName, title, url, declaredHeaders, headerValues: headerName ? { [headerName]: headerValue } : {}, personal: hasKey && body?.keyMode === 'personal' }, authn.user.id); }
        catch (e) { return reply(res, e.status || 400, { error: e.message }); }
        syncDirectoryServers();
        await discoverMcpTools(true);
        return reply(res, 201, { server: { ...added, toolCount: found.size }, servers: describe() });
      }
      // A hand-registered app for a sign-in service that does not let apps register themselves.
      const appRoute = p.match(/^\/api\/admin\/mcp-directory\/([a-z0-9-]+)\/oauth-client$/);
      if (appRoute && req.method === 'PUT') {
        const sv = MCP_SERVERS.find((x) => x.id === appRoute[1] && x.auth === 'oauth');
        if (!sv) return reply(res, 404, { error: 'No such sign-in server.' });
        let body; try { body = await readJson(req); } catch { return reply(res, 400, { error: 'invalid JSON' }); }
        try {
          const challenge = (await probeMcpAuth(sv.url)).challenge;
          await mcpOAuth.setClient({ serverId: sv.id, serverUrl: sv.url, clientId: body?.clientId, clientSecret: body?.clientSecret, challenge });
          auth.audit('mcp.oauth.client', authn.user.id, authn.user.id, { serverId: sv.id });
          const signIn = await mcpOAuth.start({ userId: authn.user.id, serverId: sv.id, serverUrl: sv.url, challenge, purpose: 'add' });
          return reply(res, 200, { signIn, servers: describe() });
        } catch (e) { return reply(res, e.status || 502, { error: e.message }); }
      }
      const del = p.match(/^\/api\/admin\/mcp-directory\/([a-z0-9-]+)$/);
      if (del && req.method === 'DELETE') {
        mcpOAuth.forget(del[1]);
        try { directoryMcp.remove(del[1], authn.user.id); } catch (e) { return reply(res, e.status || 400, { error: e.message }); }
        syncDirectoryServers();
        await discoverMcpTools(true);
        return reply(res, 200, { servers: describe() });
      }
      return reply(res, 405, { error: 'method not allowed' });
    }
    return false;
  };
}
module.exports = { createMcpDirectoryRoutes };
