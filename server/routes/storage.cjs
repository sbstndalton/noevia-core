'use strict';

const { S3_REGION_RE } = require('../s3-region.cjs');
const { checkLogin } = require('../storage-client.cjs');
const { requireJsonObject } = require('../http.cjs');
const { RUST_STORAGE_READS_REFUSAL, RUST_STORAGE_BROWSE_REFUSAL } = require('../features.cjs');
const rustStorageIntegrations = require('../rust-storage-integrations.cjs');
// The user's own storage connection (Settings → Diary & storage): save it (PUT). Reading it,
// browsing and reading files are the Rust front's (#1071); so are creating a folder, testing a
// connection and the Nextcloud Login Flow v2 (sbstndalton/noevia#2190, rust-storage-integrations.cjs).
//
// Returns true when it handled the request. Auth and CSRF run before routes are mounted.
// Every outbound target passes the member-origin policy (ssrf.cjs) first; that policy is the
// choke point, because everything downstream fetches the *saved* baseUrl.

const STORAGE_PRIVATE_URL_ERROR = 'An http(s) server URL is required. This server is not approved for member connections. Ask an administrator to add its origin to MEMBER_OUTBOUND_ORIGINS.';

const STORAGE_LOGIN_REJECTED = 'The server rejected this username or app password.';
const STORAGE_UNVERIFIED = 'Saved, but the storage server could not be reached to check the login.';
// #776: the server answered with a 3xx; the login was not checked because redirects are refused.
const STORAGE_REDIRECTED = 'Saved, but the server redirected the login check. Check the URL (https, trailing slash).';
// #773: the server answered, just not with a usable reply, so it was reached.
const storageUncheckedMessage = (status) => `Saved, but the login could not be checked (the storage server answered ${status}).`;
// #1427: a timeout is worth its own words, because a Nextcloud that has seen repeated failed
// logins from this address delays every login attempt.
const STORAGE_TIMED_OUT = 'Saved, but the storage server could not be reached within 10 seconds to check the login. Nextcloud slows logins down after repeated failures; press Test again in a few minutes.';
// #1427: 429 is Nextcloud's brute-force protection, not a wrong password and not an outage.
const STORAGE_THROTTLED = 'Saved, but the storage server is throttling logins from noevia after too many failed attempts, so the login was not checked. Wait, then press Test.';
// Kinds that authenticate with a WebDAV username and app password (#770).
const DAV_KINDS = new Set(['nextcloud', 'webdav']);

const PASS = Symbol('unhandled');

/**
 * @param {object} deps
 * @param {(res, status, body) => any} deps.json
 * @param {(req) => Promise<any>} deps.readJson
 * @param {object} deps.authService
 * @param {(authn, url:string) => boolean} deps.endpointApproved
 * @param {(...args) => Promise<Response>} deps.fetch     resolved per call so tests can swap the global
 */
function createStorageRoutes({ json, readJson: readAnyJson, authService, endpointApproved, fetch, storageLatch = null }) {
  // Every body these routes read is a JSON object; `null`, an array or a number is a 400 (#786).
  const readJson = requireJsonObject(readAnyJson);
  // #1589: a save whose login was just checked and accepted proves the saved login is good again, so the
  // hold on this account's automatic calls (storage-latch.cjs) ends. The Rust front's folder write and
  // connection test prove it through the latch's proof file instead (storage-latch.cjs `proofOf`).
  const loginProven = (authn, connection) => {
    try {
      if (!storageLatch || !authn?.user) return;
      const saved = authService.getStorage(authn.user.id, true);
      if (storageLatch.fingerprintOf(saved) === storageLatch.fingerprintOf(connection)) storageLatch.clear(authn.user.id);
    } catch { /* the hold simply stays */ }
  };
  async function storageEndpointAllowed(authn, rawUrl) {
    return endpointApproved(authn, rawUrl);
  }

  async function handle(req, res, { path: p, authn }) {
    // sbstndalton/noevia#1071: the connection's metadata GET, the list and the text read belong to
    // the Rust front (noevia-rs crates/server-storage-reads). One that reaches Node is a bypass,
    // refused before the row is read or resealed. (The metadata GET is normally refused even
    // earlier, before authentication: features.cjs refuseRustStorageRead.)
    if (p === '/api/integrations/storage' && req.method === 'GET') return json(res, 503, RUST_STORAGE_READS_REFUSAL);
    if (/^\/api\/integrations\/storage\/files(?:\/.*)?$/.test(p) && req.method === 'GET') return json(res, 503, RUST_STORAGE_BROWSE_REFUSAL);
    if (p === '/api/integrations/storage/file' && req.method === 'POST') return json(res, 503, RUST_STORAGE_BROWSE_REFUSAL);
    // sbstndalton/noevia#2190: the folder write, the connection test and the Nextcloud sign-in belong
    // to the Rust front (noevia-rs storage_integration_routes.rs). One that reaches Node is a bypass,
    // refused before the row is read (they are normally refused even earlier, before
    // authentication: rust-storage-integrations.cjs).
    if (req.method === 'POST' && rustStorageIntegrations.owned(p)) return json(res, 503, rustStorageIntegrations.ROUTE_REFUSAL);

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
      // A login that was just checked and accepted ends the hold even when the credentials are unchanged.
      if (DAV_KINDS.has(body.kind) && !warning) loginProven(authn, body);
      return json(res, 200, warning ? { ...saved, ...warning } : saved);
    }
    return PASS;
  }

  return async function storageRoutes(req, res, ctx) {
    return (await handle(req, res, ctx)) !== PASS;
  };
}

module.exports = { createStorageRoutes, STORAGE_PRIVATE_URL_ERROR };
