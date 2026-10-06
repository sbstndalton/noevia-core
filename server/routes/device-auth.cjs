'use strict';
// The HTTP surface of native-client sign-in (#555, device-auth.cjs). Two mounts, like auth.cjs:
//   open     before the session gate. While the nativeClientAuth feature is off, every path here
//            (and the /device approval page) answers 404, as if it did not exist. While it is on:
//              POST /api/auth/device/code    { client_name }            -> RFC 8628 §3.2 response
//              POST /api/auth/device/token   { grant_type, device_code | refresh_token }
//            and a request that carries BOTH a device bearer token and a session cookie is
//            refused with 400, so neither credential can ride along with the other.
//   account  after the session, CSRF and browser-only gates.
//              POST   /api/auth/device/lookup   { user_code }                browser session only
//              POST   /api/auth/device/approve  { user_code, approve }       browser session only
//              GET    /api/auth/devices                                      browser session only
//              DELETE /api/auth/devices/{id}                                 browser session only
//              GET    /api/auth/session   and   POST /api/auth/logout        for a device token
//
// Each mount returns true when it handled the request.

const { readBody } = require('../http.cjs');
const { bearerToken, hasSessionCookie } = require('../device-auth.cjs');

const PASS = Symbol('unhandled');
const DEVICE_API = /^\/api\/auth\/(device\/(code|token|lookup|approve)|devices(\/[^/]+)?)$/;

/** RFC 8628 clients send form bodies; NoeviaKit sends JSON. Both are accepted. */
async function readTokenBody(req) {
  const raw = await readBody(req, 16 * 1024);
  const type = String(req.headers['content-type'] || '').toLowerCase();
  if (type.startsWith('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(raw));
  try { const value = raw ? JSON.parse(raw) : {}; return value && typeof value === 'object' && !Array.isArray(value) ? value : null; }
  catch { return null; }
}

/**
 * @param {object} deps
 * @param {(res, status, body) => any} deps.json
 * @param {(res, result) => any} deps.authResult
 * @param {(req) => Promise<any>} deps.readJson
 * @param {ReturnType<import('../device-auth.cjs')['createDeviceAuth']>} deps.deviceAuth
 * @param {{ originValid: (req) => boolean }} deps.authService
 * @param {() => boolean} deps.enabled     features.enabled('nativeClientAuth'), read per request
 */
function createDeviceAuthRoutes({ json, authResult, readJson, deviceAuth, authService, enabled }) {
  async function open(req, res, { path: p }) {
    const isDevicePath = DEVICE_API.test(p) || p === '/device' || p === '/device/';
    if (!enabled()) return isDevicePath ? json(res, 404, { error: 'not found' }) : PASS;
    if (p.startsWith('/api/') && bearerToken(req) && hasSessionCookie(req)) {
      return json(res, 400, { error: 'Send either a session cookie or a bearer token, not both.', code: 'ambiguous_credentials' });
    }
    if (p !== '/api/auth/device/code' && p !== '/api/auth/device/token') return PASS;
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
    // Same rule as the other sign-in routes: a browser page on a foreign origin is refused.
    if (!authService.originValid(req)) return json(res, 403, { error: 'origin not allowed' });
    const body = await readTokenBody(req);
    if (!body) return json(res, 400, { error: 'invalid_request', error_description: 'The body must be JSON or form-encoded.' });
    return authResult(res, p === '/api/auth/device/code' ? deviceAuth.start(req, body) : deviceAuth.token(req, body));
  }

  async function account(req, res, { path: p, authn }) {
    if (!enabled() || !authn) return PASS;
    if (authn.device) {
      if (p === '/api/auth/session' && req.method === 'GET') {
        return json(res, 200, { user: authn.user, csrfToken: null, legacy: false, accountRole: authn.accountRole,
          device: { id: authn.device.id, clientName: authn.device.clientName, expiresAt: authn.device.expiresAt } });
      }
      if (p === '/api/auth/logout' && req.method === 'POST') {
        deviceAuth.revoke(authn.user.id, authn.device.id, authn.user.id, 'sign-out');
        return json(res, 200, { ok: true });
      }
      return PASS;
    }
    if (!DEVICE_API.test(p)) return PASS;
    // Approving another device or managing devices needs a signed-in browser: a cookie session.
    // The legacy service bearer (UI_AUTH_TOKEN) has no session and is refused too.
    if (!authn.session) return json(res, 403, { error: 'This needs a signed-in browser session.', code: 'browser_session_required' });
    if (p === '/api/auth/device/lookup' && req.method === 'POST') {
      const body = await readJson(req);
      return authResult(res, deviceAuth.lookup(authn.user.id, body?.user_code));
    }
    if (p === '/api/auth/device/approve' && req.method === 'POST') {
      const body = await readJson(req);
      if (typeof body?.approve !== 'boolean') return json(res, 400, { error: 'approve must be true or false' });
      // The session was checked before the body was read: pass the account's credential epoch as
      // read with it, so a recovery in between refuses the approval (#933). null never matches.
      return authResult(res, deviceAuth.decide(authn.user.id, body.user_code, body.approve, authn.session.credential_epoch ?? null));
    }
    if (p === '/api/auth/devices' && req.method === 'GET') {
      res.setHeader('Cache-Control', 'no-store');
      return json(res, 200, { devices: deviceAuth.list(authn.user.id) });
    }
    if (p.startsWith('/api/auth/devices/') && req.method === 'DELETE') {
      const id = p.slice('/api/auth/devices/'.length);
      // Only the owner's own grant: another account's id is the same 404 as an unknown one.
      return /^[a-f0-9]{32}$/.test(id) && deviceAuth.revoke(authn.user.id, id) ? json(res, 200, { ok: true }) : json(res, 404, { error: 'not found' });
    }
    return json(res, 405, { error: 'method not allowed' });
  }

  const mount = (fn) => async (req, res, ctx) => (await fn(req, res, ctx)) !== PASS;
  return { open: mount(open), account: mount(account) };
}

module.exports = { createDeviceAuthRoutes, DEVICE_API };
