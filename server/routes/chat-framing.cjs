'use strict';
// Chat framing, phase 1 (#737):
//   POST /api/chat-framing/suggest        { message, chatId? } -> { frame|null, reason }  signed-in user
//        rate limited per user (#760): over the budget, 429 { frame:null, reason:'rate-limited' }
//   GET/PUT /api/chat-framing/preferences is permanently Rust-owned; Node refuses (#1071).
//   GET/PUT /api/admin/framing-settings   { framingRouterModel, framingReasonerModel }    admin
// The suggestion is read-only: nothing is saved and nothing reaches the prompt. Only the signed-in
// user's own projects and chats (the request-scoped workspace) are offered as options.
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
 * @param {{ suggest: Function }} deps.framing
 * @param {{ get: Function, save: Function }} deps.settings
 * @param {() => { projects: object[], chats: object[] }} deps.workspace  the current user's own lists
 * @param {(userId:string) => boolean} [deps.rateLimited]  true when this user is over the suggest budget (#760)
 */
function createChatFramingRoutes({ json, readJson, framing, settings, workspace, rateLimited = () => false }) {
  return async function chatFramingRoutes(req, res, { path, authn }) {
    if (path === '/api/chat-framing/suggest') {
      if (!authn) return json(res, 401, { error: 'Sign in required' }), true;
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' }), true;
      if (rateLimited(authn.user.id)) return json(res, 429, { frame: null, reason: 'rate-limited' }), true;
      let body;
      try { body = await readJson(req); } catch { return json(res, 400, { error: 'Invalid request' }), true; }
      if (typeof body?.message !== 'string') return json(res, 400, { error: 'message required' }), true;
      let lists;
      try { lists = workspace(); } catch { return json(res, 200, { frame: null, reason: 'error' }), true; }
      const result = await framing.suggest({ message: body.message.slice(0, 4000), chatId: typeof body.chatId === 'string' ? body.chatId : null,
        projects: lists.projects, chats: lists.chats });
      return json(res, 200, result), true;
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
