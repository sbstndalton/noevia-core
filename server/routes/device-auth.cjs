'use strict';
// What is still Node's of native-client sign-in (#555, device-auth.cjs). The device flow itself
// (POST /api/auth/device/code|token|lookup|approve, GET /api/auth/devices, DELETE
// /api/auth/devices/{id}) and a device token's GET /api/auth/session and POST /api/auth/logout are
// the Rust front's (sbstndalton/noevia#1071; rust-auth.cjs OWNED_ROUTES refuses them before this
// module runs). One mount remains, before the session gate:
//   open     while the nativeClientAuth feature is off, the /device approval page answers 404, as
//            if it did not exist; and a request to /api/ that carries BOTH a device bearer token
//            and a session cookie is refused with 400, so neither credential can ride along with
//            the other on the routes Node still answers.
//
// It returns true when it handled the request.

const { bearerToken, hasSessionCookie } = require('../device-auth.cjs');

const PASS = Symbol('unhandled');
const DEVICE_API = /^\/api\/auth\/(device\/(code|token|lookup|approve)|devices(\/[^/]+)?)$/;

/**
 * @param {object} deps
 * @param {(res, status, body) => any} deps.json
 * @param {() => boolean} deps.enabled     features.enabled('nativeClientAuth'), read per request
 */
function createDeviceAuthRoutes({ json, enabled }) {
  async function open(req, res, { path: p }) {
    const isDevicePage = p === '/device' || p === '/device/';
    if (!enabled()) return isDevicePage ? json(res, 404, { error: 'not found' }) : PASS;
    if (p.startsWith('/api/') && bearerToken(req) && hasSessionCookie(req)) {
      return json(res, 400, { error: 'Send either a session cookie or a bearer token, not both.', code: 'ambiguous_credentials' });
    }
    return PASS;
  }

  const mount = (fn) => async (req, res, ctx) => (await fn(req, res, ctx)) !== PASS;
  return { open: mount(open) };
}

module.exports = { createDeviceAuthRoutes, DEVICE_API };
