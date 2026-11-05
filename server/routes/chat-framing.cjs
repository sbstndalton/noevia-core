'use strict';
// Chat framing, phase 1 (#737):
//   POST /api/chat-framing/suggest is the Rust front's (chat port S4): rust-chat-framing-suggest.cjs refuses
//        it before authentication and serves the front's loopback call for the user's lists and the decision
//        service. The other methods still get this mount's signed-in 405 (a cheap authenticated probe).
//   GET/PUT /api/chat-framing/preferences is permanently Rust-owned; Node refuses (#1071).
//   GET/PUT /api/admin/framing-settings   { framingRouterModel, framingReasonerModel }    admin
// Returns true when it handled the request. Auth and CSRF run before routes are mounted.

const PREFERENCES_PATH = '/api/chat-framing/preferences';
const PREFERENCES_REFUSAL = Object.freeze({ error: 'Chat framing preferences are owned by the Rust front.', code: 'RUST_FRAMING_PREFERENCES_OWNED' });
// Runs before authentication/workspace initialization in index.cjs. Invalid URLs
// and sibling routes retain the existing request chain and its error ordering.
function refuseOwnedPreferences(req, res, { parseRequestUrl, json }) {
  const url = parseRequestUrl(req, `http://${req.headers.host || 'localhost'}`) || parseRequestUrl(req);
  if (!url || url.pathname !== PREFERENCES_PATH) return false;
  json(res, 503, PREFERENCES_REFUSAL);
  return true;
}

/**
 * @param {object} deps
 * @param {{ get: Function, save: Function }} deps.settings
 */
function createChatFramingRoutes({ json, readJson, settings }) {
  return async function chatFramingRoutes(req, res, { path, authn }) {
    if (path === '/api/chat-framing/suggest') {
      if (!authn) return json(res, 401, { error: 'Sign in required' }), true;
      // The POST never gets here (refused before authentication); kept closed should the order change.
      if (req.method === 'POST') return json(res, 503, require('../rust-chat-framing-suggest.cjs').ROUTE_REFUSAL), true;
      return json(res, 405, { error: 'method not allowed' }), true;
    }
    // Permanent native ownership, including unsupported-method replies. No body,
    // workspace or old writer is reached when the front was bypassed.
    if (path === '/api/chat-framing/preferences') {
      return json(res, 503, PREFERENCES_REFUSAL), true;
    }
    if (path === '/api/admin/framing-settings') {
      if (!authn || authn.user.role !== 'admin') return json(res, 403, { error: 'Administrator required' }), true;
      if (!['GET', 'PUT'].includes(req.method)) return json(res, 405, { error: 'method not allowed' }), true;
      try {
        return json(res, 200, req.method === 'GET' ? settings.get() : settings.save(await readJson(req), authn.user.id)), true;
      } catch (error) { return json(res, error.status || 400, { error: error.status ? error.message : 'Invalid framing settings' }), true; }
    }
    return false;
  };
}

module.exports = { createChatFramingRoutes, refuseOwnedPreferences };
