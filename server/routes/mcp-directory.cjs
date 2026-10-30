'use strict';
const crypto = require('node:crypto');
const { isJsonObject } = require('../http.cjs');
const previewKey = crypto.randomBytes(32);
const PREVIEW_TTL_MS = 5 * 60 * 1000;
// MCP servers that were added from the Plugins page. Each account's own key or sign-in for them
// (GET /api/mcp-keys/servers, PUT|DELETE /api/mcp-keys/:id, GET /api/mcp-oauth/servers,
// POST /api/mcp-oauth/:id/connect, DELETE /api/mcp-oauth/:id and GET /api/mcp-oauth/callback) is the
// Rust front's since sbstndalton/noevia#2202 (rust-mcp-credentials.cjs refuses those methods before
// authentication); what stays here is the administrator's side:
//   GET/POST /api/admin/mcp-directory                  admin: list / add a registry server
//   POST   /api/admin/mcp-directory/custom/preview     admin: validate and list tools without saving
//   POST   /api/admin/mcp-directory/custom             admin: add any server by URL
//   PUT    /api/admin/mcp-directory/:id/keys           admin: replace a shared key
//   PUT    /api/admin/mcp-directory/:id/oauth-client   admin: hand-registered app
//   DELETE /api/admin/mcp-directory/:id
// The sign-ins, the registered apps and every account's key are asked of the broker (`mcpOAuth`,
// `mcpKeys`); this module never touches those tables.
// Returns true when it handled the request. Discovery and the directory state stay in
// index.cjs and are injected; `servers` is the live MCP_SERVERS array (mutated in place by
// `syncDirectoryServers`), never a copy.
function createMcpDirectoryRoutes({ json, readJson, auth, servers: MCP_SERVERS, mcpState, directoryMcp, mcpOAuth, mcpKeys = null, discoverOneServer, discoverMcpTools, probeMcpAuth, syncDirectoryServers, directoryUrlAllowed, onToolsChange = () => {} }) {
  const reply = (res, code, body) => (json(res, code, body), true);
  // A body that parses but is not an object (null, a number, an array) is the client's mistake: it
  // takes the same 400 as unparseable JSON instead of a TypeError further down (#796).
  const readObject = async (req) => {
    const body = await readJson(req);
    if (!isJsonObject(body)) throw Object.assign(new SyntaxError('request body must be a JSON object'), { status: 400 });
    return body;
  };
  // A personal server's adding administrator keeps the key they typed as their own: stored by the
  // broker (never from here). Anything that goes wrong removes the server again, so none is left
  // that no one can list tools of.
  async function keepAdminKey(added, pendingHeaders, actorId) {
    if (!added.personal) return null;
    try {
      if (!mcpKeys) throw Object.assign(new Error('Keys cannot be stored on this server.'), { status: 503 });
      await mcpKeys.set(actorId, added.id, pendingHeaders);
      return null;
    } catch (e) {
      try { directoryMcp.remove(added.id, actorId); } catch { /* already gone */ }
      await mcpOAuth.forget(added.id).catch(() => {});
      syncDirectoryServers();
      return { status: e.status >= 400 && e.status < 600 ? e.status : 503, error: e.message };
    }
  }
  const catalog = (tools) => [...tools].map((entry) => entry.tool || entry).map((tool) => tool.function).sort((a, b) => String(a?.name).localeCompare(String(b?.name)));
  const previewSignature = (actor, form, catalogValue, expires) => crypto.createHmac('sha256', previewKey)
    .update(JSON.stringify([actor, form, catalogValue, expires])).digest('hex');
  const issuePreview = (actor, form, catalogValue) => {
    const expires = Date.now() + PREVIEW_TTL_MS;
    return `${expires}.${previewSignature(actor, form, catalogValue, expires)}`;
  };
  const matchesPreview = (token, actor, form, catalogValue) => {
    const match = /^(\d{13})\.([0-9a-f]{64})$/.exec(String(token || ''));
    if (!match || Number(match[1]) < Date.now()) return false;
    const expected = previewSignature(actor, form, catalogValue, Number(match[1]));
    return crypto.timingSafeEqual(Buffer.from(match[2], 'hex'), Buffer.from(expected, 'hex'));
  };

  return async function mcpDirectoryRoutes(req, res, { path: p, authn }) {
    // Plugins → MCP servers → Add: administrators only; the URL comes from the registry, not the client.
    if (p === '/api/admin/mcp-directory' || p.startsWith('/api/admin/mcp-directory/')) {
      if (!authn || authn.user.role !== 'admin') return reply(res, 403, { error: 'Administrator required' });
      const redirectUri = `${String(auth.origin || process.env.PUBLIC_ORIGIN || '').replace(/\/$/, '')}/api/mcp-oauth/callback`;
      const describe = async () => Promise.all(directoryMcp.list().map(async (s) => {
        const st = mcpState.servers.get(s.id);
        // These are the tools actually bound to this server's toolbox, not the global
        // name registry (where collisions can hide a server's own tools).
        const box = (mcpState.boxes || []).find((b) => b.directory && b.server === s.id && b.id === s.id);
        const tools = (box?.tools || []).slice(0, 40).map((t) => ({
          name: String(t.function?.name || '').slice(0, 120),
          description: String(t.function?.description || '').slice(0, 240),
        }));
        return { ...s, toolCount: st?.toolCount ?? null, tools, toolsTruncated: (box?.tools?.length || 0) > tools.length,
          error: st?.error || null, ...(s.oauth ? { oauthClient: await mcpOAuth.clientInfo(s.id).catch(() => null), redirectUri } : {}) };
      }));
      if (p === '/api/admin/mcp-directory' && req.method === 'GET') return reply(res, 200, { servers: await describe() });
      if (p === '/api/admin/mcp-directory' && req.method === 'POST') {
        let body; try { body = await readObject(req); } catch { return reply(res, 400, { error: 'invalid JSON' }); }
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
              return reply(res, 202, { signIn, server: added, servers: await describe() });
            } catch (err) {
              // The service needs an app registered by hand: keep the server and ask for the app.
              if (err.needsClient) return reply(res, 202, { needsClient: true, issuer: err.issuer, redirectUri, server: added, servers: await describe() });
              directoryMcp.remove(added.id, authn.user.id); await mcpOAuth.forget(added.id).catch(() => {}); syncDirectoryServers();
              return reply(res, 422, { error: `The server needs a sign-in noevia cannot do: ${err.message}` });
            }
          } return reply(res, 422, { error: `${hasKey ? 'The server did not accept that key, or' : 'The server'} did not answer as an MCP server: ${String(e.message || e).slice(0, 200)}` }); }
        if (!found.size) return reply(res, 422, { error: 'The server answered but offers no tools noevia can use.' });
        let added;
        try { added = directoryMcp.add({ registryName: item.id, title: item.name, url: item.remoteUrl, declaredHeaders: item.headers || [], headerValues: body.headers || {}, personal: hasKey && body.keyMode === 'personal' }, authn.user.id); } catch (e) { return reply(res, e.status || 400, { error: e.message }); }
        const kept = await keepAdminKey(added, pendingHeaders, authn.user.id);
        if (kept) return reply(res, kept.status, { error: kept.error });
        syncDirectoryServers();
        await discoverMcpTools(true);
        return reply(res, 201, { server: { ...added, toolCount: found.size }, servers: await describe() });
      }
      // Change a server's key: checked against the server before it replaces the old one.
      const keys = p.match(/^\/api\/admin\/mcp-directory\/([a-z0-9-]+)\/keys$/);
      if (keys && req.method === 'PUT') {
        const row = directoryMcp.list().find((s) => s.id === keys[1]);
        if (!row) return reply(res, 404, { error: 'No such server.' });
        let body; try { body = await readObject(req); } catch { return reply(res, 400, { error: 'invalid JSON' }); }
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
        return reply(res, 200, { servers: await describe() });
      }
      // Add any MCP server by its URL (roadmap: Customize backends). Same rules as a directory
      // server: hosted https, public address, must answer, its own toolbox, every tool asks.
      if ((p === '/api/admin/mcp-directory/custom' || p === '/api/admin/mcp-directory/custom/preview') && req.method === 'POST') {
        const preview = p.endsWith('/preview');
        let body; try { body = await readObject(req); } catch { return reply(res, 400, { error: 'invalid JSON' }); }
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
        const previewForm = [title, url, headerName, headerValue, body?.keyMode === 'shared' ? 'shared' : 'personal'];
        const consent = (tools) => matchesPreview(body?.previewToken, authn.user.id, previewForm, tools);
        let found;
        try { found = await discoverOneServer({ id: directoryMcp.idFor(registryName), url, auth: hasKey ? 'directory' : 'none', directory: true, pendingHeaders }); }
        catch (e) {
          const probe = !hasKey ? await probeMcpAuth(url) : { status: 0 };
          if (probe.status === 401) {
            if (preview) return reply(res, 200, { requiresSignIn: true, toolCount: null, tools: [], toolsTruncated: false, previewToken: issuePreview(authn.user.id, previewForm, 'sign-in') });
            if (!consent('sign-in')) return reply(res, 409, { error: 'The server or access details changed since preview. Preview again before connecting.' });
            let added;
            try { added = directoryMcp.add({ registryName, title, url, oauth: true }, authn.user.id); } catch (err) { return reply(res, err.status || 400, { error: err.message }); }
            syncDirectoryServers();
            try {
              const signIn = await mcpOAuth.start({ userId: authn.user.id, serverId: added.id, serverUrl: url, challenge: probe.challenge, purpose: 'add' });
              return reply(res, 202, { signIn, server: added, servers: await describe() });
            } catch (err) {
              if (err.needsClient) return reply(res, 202, { needsClient: true, issuer: err.issuer, redirectUri, server: added, servers: await describe() });
              directoryMcp.remove(added.id, authn.user.id); await mcpOAuth.forget(added.id).catch(() => {}); syncDirectoryServers();
              return reply(res, 422, { error: `The server needs a sign-in noevia cannot do: ${err.message}` });
            }
          }
          return reply(res, 422, { error: `${hasKey ? 'The server did not accept that key, or' : 'The server'} did not answer as an MCP server: ${String(e.message || e).slice(0, 200)}` });
        }
        if (!found.size) return reply(res, 422, { error: 'The server answered but offers no tools noevia can use.' });
        if (preview) {
          const tools = [...found.values()].slice(0, 40).map((entry) => ({
            name: String(entry.tool?.function?.name || '').slice(0, 120),
            description: String(entry.tool?.function?.description || '').slice(0, 240),
          }));
          return reply(res, 200, { requiresSignIn: false, toolCount: found.size, tools, toolsTruncated: found.size > tools.length, previewToken: issuePreview(authn.user.id, previewForm, catalog(found.values())) });
        }
        if (!consent(catalog(found.values()))) return reply(res, 409, { error: 'The server or its tools changed since preview. Preview again before connecting.' });
        let added;
        try { added = directoryMcp.add({ registryName, title, url, declaredHeaders, headerValues: headerName ? { [headerName]: headerValue } : {}, personal: hasKey && body?.keyMode === 'personal' }, authn.user.id); }
        catch (e) { return reply(res, e.status || 400, { error: e.message }); }
        const kept = await keepAdminKey(added, pendingHeaders, authn.user.id);
        if (kept) return reply(res, kept.status, { error: kept.error });
        syncDirectoryServers();
        let rediscovered = false;
        try {
          await discoverMcpTools(true);
          const box = (mcpState.boxes || []).find((b) => b.directory && b.server === added.id && b.id === added.id);
          rediscovered = !!box && consent(catalog(box.tools || []));
        } catch { /* A failed rediscovery must not leave the server enabled. */ }
        if (!rediscovered) {
          // A concurrent delete may already have removed it; either way the answer is the same 409.
          try { directoryMcp.remove(added.id, authn.user.id); } catch { /* Already gone. */ }
          // The adding administrator's key (keepAdminKey stored it with the broker) goes with the server it
          // was for. An id is derived from the server's name, so adding the same server again would otherwise
          // inherit a key that was never kept on purpose.
          await mcpOAuth.forget(added.id).catch(() => {});
          syncDirectoryServers();
          try { await discoverMcpTools(true); } catch { /* The saved entry is already gone. */ }
          return reply(res, 409, { error: 'The server’s tools changed while connecting. It was not kept; preview again.' });
        }
        return reply(res, 201, { server: { ...added, toolCount: found.size }, servers: await describe() });
      }
      // A hand-registered app for a sign-in service that does not let apps register themselves.
      const appRoute = p.match(/^\/api\/admin\/mcp-directory\/([a-z0-9-]+)\/oauth-client$/);
      if (appRoute && req.method === 'PUT') {
        const sv = MCP_SERVERS.find((x) => x.id === appRoute[1] && x.auth === 'oauth');
        if (!sv) return reply(res, 404, { error: 'No such sign-in server.' });
        let body; try { body = await readObject(req); } catch { return reply(res, 400, { error: 'invalid JSON' }); }
        try {
          const challenge = (await probeMcpAuth(sv.url)).challenge;
          await mcpOAuth.setClient({ serverId: sv.id, serverUrl: sv.url, clientId: body?.clientId, clientSecret: body?.clientSecret, challenge });
          auth.audit('mcp.oauth.client', authn.user.id, authn.user.id, { serverId: sv.id });
          const signIn = await mcpOAuth.start({ userId: authn.user.id, serverId: sv.id, serverUrl: sv.url, challenge, purpose: 'add' });
          return reply(res, 200, { signIn, servers: await describe() });
        } catch (e) { return reply(res, e.status || 502, { error: e.message }); }
      }
      const del = p.match(/^\/api\/admin\/mcp-directory\/([a-z0-9-]+)$/);
      if (del && req.method === 'DELETE') {
        // Every account's sign-in, the registered app and every account's key go first: if the broker
        // cannot, the server stays (a row removed with credentials left behind could not be retried).
        try { await mcpOAuth.forget(del[1]); } catch (e) { return reply(res, e.status || 503, { error: e.message }); }
        try { directoryMcp.remove(del[1], authn.user.id); } catch (e) { return reply(res, e.status || 400, { error: e.message }); }
        syncDirectoryServers();
        await discoverMcpTools(true);
        return reply(res, 200, { servers: await describe() });
      }
      return reply(res, 405, { error: 'method not allowed' });
    }
    return false;
  };
}
module.exports = { createMcpDirectoryRoutes };
