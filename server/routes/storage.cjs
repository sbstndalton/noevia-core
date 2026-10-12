'use strict';

const { normalizeS3Region, S3_REGION_RE } = require('../s3-region.cjs');
const { checkLogin } = require('../storage-client.cjs');
const { requireJsonObject, readCappedJson } = require('../http.cjs');
const { RUST_STORAGE_READS_REFUSAL } = require('../features.cjs');
// A Nextcloud login-flow reply is a few hundred bytes; a server that streams more is refused (#902).
const NEXTCLOUD_REPLY_CAP = 64 * 1024;
// The user's own storage connection (Settings → Diary & storage): read and save it, test it,
// browse and read files over it for project knowledge, create one folder, and the Nextcloud
// Login Flow v2 that turns a URL into an app password without the user typing a secret here.
//
// Returns true when it handled the request. Auth and CSRF run before routes are mounted.
// Every outbound target — the saved connection, a URL being tested, the poll endpoint the
// remote server hands back — passes the member-origin policy (ssrf.cjs) first; that policy
// is the choke point, because everything downstream fetches the *saved* baseUrl.

const STORAGE_PRIVATE_URL_ERROR = 'An http(s) server URL is required. This server is not approved for member connections. Ask an administrator to add its origin to MEMBER_OUTBOUND_ORIGINS.';

const STORAGE_LOGIN_REJECTED = 'The server rejected this username or app password.';
const STORAGE_UNVERIFIED = 'Saved, but the storage server could not be reached to check the login.';
// #776: the server answered with a 3xx; the login was not checked because redirects are refused.
const STORAGE_REDIRECTED = 'Saved, but the server redirected the login check. Check the URL (https, trailing slash).';
// #773: the server answered, just not with a usable reply, so it was reached.
const storageUncheckedMessage = (status) => `Saved, but the login could not be checked (the storage server answered ${status}).`;
// #1427: the server answered quickly enough before; a timeout is worth its own words, because a
// Nextcloud that has seen repeated failed logins from this address delays every login attempt.
const STORAGE_TIMED_OUT = 'Saved, but the storage server could not be reached within 10 seconds to check the login. Nextcloud slows logins down after repeated failures; press Test again in a few minutes.';
// #1427: 429 is Nextcloud's brute-force protection, not a wrong password and not an outage.
const STORAGE_THROTTLED = 'Saved, but the storage server is throttling logins from noevia after too many failed attempts, so the login was not checked. Wait, then press Test.';
// Kinds that authenticate with a WebDAV username and app password (#770).
const DAV_KINDS = new Set(['nextcloud', 'webdav']);
// #1427: the name Nextcloud gives the app password (it shows "grant <name> access" and lists the
// device under Security). Without it the token was called "node".
const NEXTCLOUD_CLIENT_NAME = 'Noevia';
const NEXTCLOUD_TIMEOUT_MS = 10000;

/** #1427: the address a person opens Nextcloud with, from whatever they pasted: the browser URL of
 *  the Files app, a WebDAV URL from a saved connection, or the bare server. Only the scheme, host,
 *  port and any sub-path Nextcloud is installed under are kept. Returns '' for a non-URL. */
function nextcloudServerRoot(raw) {
  let url;
  try { url = new URL(String(raw || '').trim()); } catch { return ''; }
  if (url.username || url.password) return '';
  const path = url.pathname.replace(/\/(?:remote\.php|index\.php|apps|ocs|login|status\.php)(?:\/.*)?$/i, '').replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${path}`;
}

/** #1427: a Nextcloud error the browser can word: what happened, in a stable `code`. */
function nextcloudFailure(err, host) {
  const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
  if (timeout) return { status: 504, body: { error: `Nextcloud at ${host} did not answer within 10 seconds.`, code: 'nextcloudUnreachable', reason: 'timeout' } };
  if (err && err.name === 'TypeError' && /redirect/i.test(String(err.cause?.message || ''))) {
    return { status: 502, body: { error: `Nextcloud at ${host} redirected the request. Use the exact https:// address you open Nextcloud with.`, code: 'nextcloudUnreachable', reason: 'redirect' } };
  }
  return { status: 502, body: { error: `Could not reach Nextcloud at ${host}.`, code: 'nextcloudUnreachable', reason: 'network' } };
}

function nextcloudStatusFailure(status, host, headers) {
  if (status === 429) {
    const wait = Number(headers?.get?.('retry-after'));
    const retryAfter = Number.isFinite(wait) && wait > 0 ? Math.min(Math.ceil(wait), 86400) : undefined;
    return { status: 429, body: { error: `Nextcloud at ${host} is throttling sign-ins from noevia after too many failed attempts. Wait a few minutes and try again.`, code: 'nextcloudThrottled', ...(retryAfter ? { retryAfter } : {}) } };
  }
  if (status === 404) return { status: 502, body: { error: `No Nextcloud sign-in was found at ${host} (404). Check the address.`, code: 'nextcloudNotFound', status } };
  return { status: 502, body: { error: `Nextcloud returned ${status}`, code: 'nextcloudError', status } };
}

const hostOf = (url) => { try { return new URL(url).host; } catch { return 'that address'; } };

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
 * @param {() => boolean} [deps.storageReadsOwned] confirmed deployment owner; defaults off
 */
function createStorageRoutes({ json, readJson: readAnyJson, authService, storageClient, endpointApproved, fetch, crypto, storageReadsOwned = () => false }) {
  // Every body these routes read is a JSON object; `null`, an array or a number is a 400 (#786).
  const readJson = requireJsonObject(readAnyJson);
  const nextcloudFlows = new Map();
  async function storageEndpointAllowed(authn, rawUrl) {
    return endpointApproved(authn, rawUrl);
  }

  async function handle(req, res, { path: p, authn }) {
    if (p === '/api/integrations/storage' && req.method === 'GET') {
      if (storageReadsOwned()) return json(res, 503, RUST_STORAGE_READS_REFUSAL);
      return json(res, 200, authService.getStorage(authn.user.id));
    }
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
        return json(res, e?.status === 400 ? 400 : 502, { error: e?.message || 'storage browse failed' });
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
      if (body.region !== undefined && body.region !== null && body.region !== '' && !S3_REGION_RE.test(String(body.region))) {
        return json(res, 400, { error: 'Region must be 1-32 lowercase letters, digits, or dashes (for example eu-west-1)' });
      }
      // #770: check the login before replacing the saved row. A rejected login keeps the old row;
      // an unreachable server still saves (it may be down for a moment) but says it was not checked.
      // Only the status is reported; the secret never reaches a log or a response.
      let warning;
      if (DAV_KINDS.has(body.kind)) {
        const check = await checkLogin({ baseUrl: body.baseUrl, username: body.username, secret: body.secret }, { fetchImpl: (...a) => fetch(...a) });
        if (check.rejected) return json(res, 400, { error: STORAGE_LOGIN_REJECTED, code: 'storageLoginRejected', status: check.status });
        if (!check.ok) warning = check.throttled ? { warning: STORAGE_THROTTLED, warningCode: 'storageThrottled', status: 429, ...(check.retryAfter ? { retryAfter: check.retryAfter } : {}) }
          : check.unverified === 'redirect' ? { warning: STORAGE_REDIRECTED, warningCode: 'storageUnverified', reason: 'redirect' }
          : check.unverified === 'timeout' ? { warning: STORAGE_TIMED_OUT, warningCode: 'storageUnverified', reason: 'timeout' }
          : check.status ? { warning: storageUncheckedMessage(check.status), warningCode: 'storageUnverified', status: check.status } : { warning: STORAGE_UNVERIFIED, warningCode: 'storageUnverified' };
      }
      const saved = authService.saveStorage(authn.user.id, body);
      return json(res, 200, warning ? { ...saved, ...warning } : saved);
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
          const signed = signS3Request('GET', new URL(target), '', saved.username || '', saved.secret || '', { region: normalizeS3Region(saved.region) });
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
      // #1427: the field may hold a saved WebDAV URL or the Files app URL; sign-in needs the root.
      const baseUrl = nextcloudServerRoot((await readJson(req)).baseUrl);
      if (!/^https:\/\//.test(baseUrl)) return json(res, 400, { error: 'Enter the https:// address you open Nextcloud with, for example https://cloud.example.com.', code: 'nextcloudHttpsRequired' });
      if (!(await storageEndpointAllowed(authn, baseUrl))) return json(res, 400, { error: STORAGE_PRIVATE_URL_ERROR });
      const host = hostOf(baseUrl);
      let response;
      try {
        response = await fetch(`${baseUrl}/index.php/login/v2`, { method: 'POST', headers: { 'User-Agent': NEXTCLOUD_CLIENT_NAME }, signal: AbortSignal.timeout(NEXTCLOUD_TIMEOUT_MS), redirect: 'error' });
      } catch (e) { const f = nextcloudFailure(e, host); return json(res, f.status, f.body); }
      if (!response.ok) { const f = nextcloudStatusFailure(response.status, host, response.headers); return json(res, f.status, f.body); }
      let payload;
      try { payload = await readCappedJson(response, NEXTCLOUD_REPLY_CAP); }
      catch { return json(res, 502, { error: `${host} answered, but not like a Nextcloud server. Check the address.`, code: 'nextcloudNotFound' }); }
      const flowId = crypto.randomUUID();
      for (const [id, flow] of nextcloudFlows) if (flow.expires < Date.now() || flow.userId === authn.user.id) nextcloudFlows.delete(id);
      if (nextcloudFlows.size >= 100) return json(res, 429, { error: 'Too many pending connections' });
      let loginHttps = false;
      try { loginHttps = new URL(payload?.login).protocol === 'https:'; } catch { /* fails closed */ }
      if (typeof payload?.poll?.endpoint !== 'string' || !endpointApproved(authn, payload.poll.endpoint) || !loginHttps) return json(res, 400, { error: 'Invalid connection URLs' });
      nextcloudFlows.set(flowId, { userId: authn.user.id, endpoint: payload.poll.endpoint, token: payload.poll.token, expires: Date.now() + 10 * 60 * 1000 });
      return json(res, 200, { flowId, loginUrl: payload.login, expiresAt: Date.now() + 10 * 60 * 1000 });
    }
    if (p === '/api/integrations/storage/nextcloud/poll' && req.method === 'POST') {
      const body = await readJson(req); const flow = nextcloudFlows.get(String(body.flowId || ''));
      if (!flow || flow.userId !== authn.user.id || flow.expires < Date.now()) return json(res, 400, { error: 'login flow expired', code: 'nextcloudFlowExpired' });
      // The poll endpoint comes from the remote server's own response, so a
      // malicious Nextcloud could redirect it inward — guard it too.
      if (!(await storageEndpointAllowed(authn, flow.endpoint))) return json(res, 400, { error: STORAGE_PRIVATE_URL_ERROR });
      const host = hostOf(flow.endpoint);
      let response;
      try {
        response = await fetch(flow.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': NEXTCLOUD_CLIENT_NAME }, body: new URLSearchParams({ token: flow.token }), signal: AbortSignal.timeout(NEXTCLOUD_TIMEOUT_MS), redirect: 'error' });
      } catch (e) { const f = nextcloudFailure(e, host); return json(res, f.status, f.body); }
      if (response.status === 404) return json(res, 202, { pending: true });
      if (!response.ok) { const f = nextcloudStatusFailure(response.status, host, response.headers); return json(res, f.status, f.body); }
      let credentials;
      try { credentials = await readCappedJson(response, NEXTCLOUD_REPLY_CAP); }
      catch (e) { return json(res, 502, { error: e.code === 'too_large' ? 'Nextcloud reply too large' : 'Nextcloud returned an unreadable reply' }); }
      // Nextcloud hands the app password out once; the flow is spent whatever happens next.
      nextcloudFlows.delete(String(body.flowId));
      const server = nextcloudServerRoot(credentials?.server);
      const loginName = String(credentials?.loginName || '');
      const appPassword = String(credentials?.appPassword || '');
      if (!server || !loginName || !appPassword) return json(res, 502, { error: 'Nextcloud returned an unreadable reply' });
      if (!endpointApproved(authn, server)) return json(res, 403, { error: STORAGE_PRIVATE_URL_ERROR });
      // #1427: the WebDAV home is /files/<user id>, and the login name (what was typed on the
      // sign-in page: often the e-mail) is not the user id. Ask Nextcloud who this app password is.
      const auth = { Authorization: `Basic ${Buffer.from(`${loginName}:${appPassword}`).toString('base64')}` };
      let userId = '';
      try {
        const who = await fetch(`${server}/ocs/v2.php/cloud/user?format=json`, { headers: { ...auth, 'OCS-APIRequest': 'true', Accept: 'application/json', 'User-Agent': NEXTCLOUD_CLIENT_NAME }, signal: AbortSignal.timeout(NEXTCLOUD_TIMEOUT_MS), redirect: 'error' });
        if (who.status === 401) return json(res, 502, { error: 'Nextcloud issued an app password and then refused it. Sign in again.', code: 'storageLoginRejected' });
        if (who.status === 429) { const f = nextcloudStatusFailure(429, host, who.headers); return json(res, f.status, f.body); }
        if (who.ok) userId = String((await readCappedJson(who, NEXTCLOUD_REPLY_CAP))?.ocs?.data?.id || '');
      } catch { /* fall back to the login name below; the DAV check decides */ }
      const baseUrl = `${server}/remote.php/dav/files/${encodeURIComponent(userId || loginName)}`;
      if (!endpointApproved(authn, baseUrl)) return json(res, 403, { error: STORAGE_PRIVATE_URL_ERROR });
      // Keep the folder the person already uses; a fresh setup gets the default.
      let corpusRoot = typeof body.corpusRoot === 'string' ? body.corpusRoot.trim() : '';
      if (!corpusRoot) { try { corpusRoot = String(authService.getStorage(authn.user.id)?.corpusRoot || ''); } catch { /* none saved */ } }
      const connection = { kind: 'nextcloud', baseUrl, username: loginName, secret: appPassword, corpusRoot: corpusRoot || 'Cowork/Diary' };
      // Same check as a manual save (#770): a refused login never replaces the working row.
      const check = await checkLogin(connection, { fetchImpl: (...a) => fetch(...a) });
      if (check.rejected) return json(res, 502, { error: 'Nextcloud refused the new app password for WebDAV. Sign in again.', code: 'storageLoginRejected', status: check.status });
      if (check.throttled) { const f = nextcloudStatusFailure(429, host, { get: () => check.retryAfter }); return json(res, f.status, f.body); }
      const saved = authService.saveStorage(authn.user.id, connection);
      if (check.ok) return json(res, 200, saved);
      return json(res, 200, { ...saved, warningCode: 'storageUnverified', ...(check.status ? { status: check.status, warning: storageUncheckedMessage(check.status) } : { reason: check.unverified, warning: check.unverified === 'timeout' ? STORAGE_TIMED_OUT : STORAGE_UNVERIFIED }) });
    }
    return PASS;
  }

  return async function storageRoutes(req, res, ctx) {
    return (await handle(req, res, ctx)) !== PASS;
  };
}

module.exports = { createStorageRoutes, STORAGE_PRIVATE_URL_ERROR, nextcloudServerRoot };
