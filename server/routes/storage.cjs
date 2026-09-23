'use strict';
// The user's own storage connection (Settings → Diary & storage): read and save it, test it,
// browse and read files over it for project knowledge, create one folder, and the Nextcloud
// Login Flow v2 that turns a URL into an app password without the user typing a secret here.
//
// Returns true when it handled the request. Auth and CSRF run before routes are mounted.
// Every outbound target — the saved connection, a URL being tested, the poll endpoint the
// remote server hands back — passes the member-origin policy (ssrf.cjs) first; that policy
// is the choke point, because everything downstream fetches the *saved* baseUrl.

const STORAGE_PRIVATE_URL_ERROR = 'An http(s) server URL is required. This server is not approved for member connections. Ask an administrator to add its origin to MEMBER_OUTBOUND_ORIGINS.';

const PASS = Symbol('unhandled');

/**
 * @param {object} deps
 * @param {(res, status, body) => any} deps.json
 * @param {(req) => Promise<any>} deps.readJson
 * @param {object} deps.authService
 * @param {object} deps.storageClient
 * @param {(authn, url:string) => boolean} deps.endpointApproved
 * @param {(...args) => Promise<Response>} deps.fetch     resolved per call so tests can swap the global
 * @param {{ randomUUID: () => string }} deps.crypto
 */
function createStorageRoutes({ json, readJson, authService, storageClient, endpointApproved, fetch, crypto }) {
  const nextcloudFlows = new Map();
  async function storageEndpointAllowed(authn, rawUrl) {
    return endpointApproved(authn, rawUrl);
  }

  async function handle(req, res, { path: p, authn }) {
    if (p === '/api/integrations/storage' && req.method === 'GET') return json(res, 200, authService.getStorage(authn.user.id));
    // Browse/read over the user's own connected storage (project knowledge
    // intake; read-only). The saved connection's own credentials are used
    // server-side and never returned to the client.
    const storageBrowse = p.match(/^\/api\/integrations\/storage\/files(?:\/(.*))?$/);
    if (storageBrowse && req.method === 'GET') {
      const connection = authService.getStorage(authn.user.id, true);
      if (!storageClient.isBrowsable(connection)) return json(res, 400, { error: 'no browsable storage connected (local storage needs no browsing — upload files directly)' });
      // Defense in depth: also guard connections saved before the save-time
      // guard existed, and saved by an admin that has since been demoted.
      if (!(await storageEndpointAllowed(authn, connection.baseUrl))) return json(res, 400, { error: STORAGE_PRIVATE_URL_ERROR });
      try {
        const entries = await storageClient.listFiles(connection, decodeURIComponent(storageBrowse[1] || ''));
        return json(res, 200, { entries });
      } catch (e) {
        return json(res, 502, { error: e?.message || 'storage browse failed' });
      }
    }
    // Creating a directory is the one write this integration performs. It is
    // deliberately narrow: MKCOL only, no file writes, no overwrite, no delete.
    const storageMkdir = p.match(/^\/api\/integrations\/storage\/folder$/);
    if (storageMkdir && req.method === 'POST') {
      const body = await readJson(req);
      const connection = authService.getStorage(authn.user.id, true);
      if (!storageClient.isBrowsable(connection)) return json(res, 400, { error: 'no browsable storage connected' });
      if (!(await storageEndpointAllowed(authn, connection.baseUrl))) return json(res, 400, { error: STORAGE_PRIVATE_URL_ERROR });
      try {
        const made = await storageClient.createFolder(connection, body.path);
        return json(res, 200, made);
      } catch (e) {
        const status = e && e.status ? e.status : 502;
        return json(res, status, { error: e?.message || 'could not create folder' });
      }
    }

    const storageRead = p.match(/^\/api\/integrations\/storage\/file$/);
    if (storageRead && req.method === 'POST') {
      const body = await readJson(req);
      const connection = authService.getStorage(authn.user.id, true);
      if (!storageClient.isBrowsable(connection)) return json(res, 400, { error: 'no browsable storage connected' });
      if (!(await storageEndpointAllowed(authn, connection.baseUrl))) return json(res, 400, { error: STORAGE_PRIVATE_URL_ERROR });
      try {
        const file = await storageClient.readTextFile(connection, body.path);
        return json(res, 200, file);
      } catch (e) {
        const status = e && e.status ? e.status : 502;
        return json(res, status, { error: e?.message || 'storage read failed' });
      }
    }
    if (p === '/api/integrations/storage' && req.method === 'PUT') {
      const body = await readJson(req);
      if (body.kind !== 'local' && (!/^https?:\/\//.test(String(body.baseUrl || '')) || !body.username || !body.secret)) {
        return json(res, 400, { error: 'server URL, username, and app password are required' });
      }
      // This is the choke point: everything downstream (tests, browsing,
      // diary corpus sync to the sidecar) fetches the *saved* baseUrl.
      if (body.kind !== 'local' && !(await storageEndpointAllowed(authn, body.baseUrl))) {
        return json(res, 400, { error: STORAGE_PRIVATE_URL_ERROR });
      }
      return json(res, 200, authService.saveStorage(authn.user.id, body));
    }
    if (p === '/api/integrations/storage/test' && req.method === 'POST') {
      const body = await readJson(req);
      if (body.kind === 'local') return json(res, 200, { ok: true });
      let saved = body.useSaved ? authService.getStorage(authn.user.id, true) : body;
      if (body.useSavedSecret === true) {
        const stored = authService.getStorage(authn.user.id, true);
        // Only this session's credential, and never forwarded to a new origin.
        let sameOrigin = false;
        try {
          const target = new URL(body.baseUrl);
          sameOrigin = !target.username && !target.password &&
            target.origin === new URL(stored.baseUrl).origin;
        } catch { /* invalid URLs fail closed */ }
        if (!sameOrigin || body.kind !== stored.kind || !stored.secret) {
          return json(res, 400, { error: 'Enter a secret to test a different server or storage type.' });
        }
        saved = { ...body, secret: stored.secret };
      }
      if (saved.kind !== 'local' && !(await storageEndpointAllowed(authn, saved.baseUrl))) {
        return json(res, 400, { error: STORAGE_PRIVATE_URL_ERROR });
      }
      if (saved.kind === 's3') {
        // S3 probe: a signed bucket listing proves endpoint reachability,
        // bucket existence, and the credentials in one shot.
        try {
          const { signS3Request } = require('../s3-sign.cjs');
          const endpoint = String(saved.baseUrl || '').replace(/\/+$/, '');
          if (!/^https?:\/\//.test(endpoint)) return json(res, 400, { error: 'Endpoint URL must start with http:// or https://' });
          const bucket = String(saved.bucket || '').trim();
          if (!bucket) return json(res, 400, { error: 'Bucket is required' });
          const target = `${endpoint}/${encodeURIComponent(bucket)}?list-type=2&max-keys=1`;
          const signed = signS3Request('GET', new URL(target), '', saved.username || '', saved.secret || '');
          const response = await fetch(target, { headers: signed, signal: AbortSignal.timeout(10000), redirect: 'error' });
          if (response.ok) return json(res, 200, { ok: true });
          const detail = response.status === 403 ? ' — check the access key and secret'
            : response.status === 404 ? ' — no such bucket'
            : response.status === 400 ? ' — server rejected the request (unsupported endpoint?)' : '';
          return json(res, 502, { error: `S3 returned ${response.status}${detail}` });
        } catch (e) { return json(res, 502, { error: e.message }); }
      }
      try {
        const target = `${String(saved.baseUrl).replace(/\/+$/, '')}/${String(saved.corpusRoot || '').split('/').map(encodeURIComponent).join('/')}`;
        const response = await fetch(target, { method: 'PROPFIND', headers: { Authorization: `Basic ${Buffer.from(`${saved.username}:${saved.secret}`).toString('base64')}`, Depth: '0' }, signal: AbortSignal.timeout(10000), redirect: 'error' });
        return json(res, response.ok || response.status === 207 ? 200 : 502, response.ok || response.status === 207 ? { ok: true } : { error: `WebDAV returned ${response.status}` });
      } catch (e) { return json(res, 502, { error: e.message }); }
    }
    if (p === '/api/integrations/storage/nextcloud/start' && req.method === 'POST') {
      const baseUrl = String((await readJson(req)).baseUrl || '').replace(/\/+$/, '');
      if (!/^https:\/\//.test(baseUrl)) return json(res, 400, { error: 'HTTPS Nextcloud URL required' });
      if (!(await storageEndpointAllowed(authn, baseUrl))) return json(res, 400, { error: STORAGE_PRIVATE_URL_ERROR });
      try {
        const response = await fetch(`${baseUrl}/index.php/login/v2`, { method: 'POST', signal: AbortSignal.timeout(10000), redirect: 'error' });
        if (!response.ok) return json(res, 502, { error: `Nextcloud returned ${response.status}` });
        const payload = await response.json(); const flowId = crypto.randomUUID();
        for (const [id, flow] of nextcloudFlows) if (flow.expires < Date.now() || flow.userId === authn.user.id) nextcloudFlows.delete(id);
        if (nextcloudFlows.size >= 100) return json(res, 429, { error: 'Too many pending connections' });
        if (!endpointApproved(authn, payload.poll?.endpoint) || new URL(payload.login).protocol !== 'https:') return json(res, 400, { error: 'Invalid connection URLs' });
        nextcloudFlows.set(flowId, { userId: authn.user.id, endpoint: payload.poll.endpoint, token: payload.poll.token, expires: Date.now() + 10 * 60 * 1000 });
        return json(res, 200, { flowId, loginUrl: payload.login, expiresAt: Date.now() + 10 * 60 * 1000 });
      } catch (e) { return json(res, 502, { error: e.message }); }
    }
    if (p === '/api/integrations/storage/nextcloud/poll' && req.method === 'POST') {
      const body = await readJson(req); const flow = nextcloudFlows.get(String(body.flowId || ''));
      if (!flow || flow.userId !== authn.user.id || flow.expires < Date.now()) return json(res, 400, { error: 'login flow expired' });
      // The poll endpoint comes from the remote server's own response, so a
      // malicious Nextcloud could redirect it inward — guard it too.
      if (!(await storageEndpointAllowed(authn, flow.endpoint))) return json(res, 400, { error: STORAGE_PRIVATE_URL_ERROR });
      const response = await fetch(flow.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: flow.token }), signal: AbortSignal.timeout(10000), redirect: 'error' });
      if (response.status === 404) return json(res, 202, { pending: true });
      if (!response.ok) return json(res, 502, { error: `Nextcloud returned ${response.status}` });
      const credentials = await response.json(); nextcloudFlows.delete(String(body.flowId));
      const baseUrl = `${String(credentials.server).replace(/\/+$/, '')}/remote.php/dav/files/${encodeURIComponent(credentials.loginName)}`;
      if (!endpointApproved(authn, baseUrl)) return json(res, 403, { error: STORAGE_PRIVATE_URL_ERROR });
      return json(res, 200, authService.saveStorage(authn.user.id, { kind: 'nextcloud', baseUrl, username: credentials.loginName, secret: credentials.appPassword, corpusRoot: body.corpusRoot || 'Cowork/Diary' }));
    }
    return PASS;
  }

  return async function storageRoutes(req, res, ctx) {
    return (await handle(req, res, ctx)) !== PASS;
  };
}

module.exports = { createStorageRoutes, STORAGE_PRIVATE_URL_ERROR };
