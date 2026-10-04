'use strict';
// Chat framing, phase 1 (#737):
//   POST /api/chat-framing/suggest        { message, chatId? } -> { frame|null, reason }  signed-in user
//        rate limited per user (#760): over the budget, 429 { frame:null, reason:'rate-limited' }
//   GET/PUT /api/chat-framing/preferences { autoAccept?, keepReasoningTraces? }         signed-in user (#738, #740)
//   GET/PUT /api/admin/framing-settings   { framingRouterModel, framingReasonerModel }    admin
// The suggestion is read-only: nothing is saved and nothing reaches the prompt. Only the signed-in
// user's own projects and chats (the request-scoped workspace) are offered as options.
// Returns true when it handled the request. Auth and CSRF run before routes are mounted.

/**
 * @param {object} deps
 * @param {{ suggest: Function }} deps.framing
 * @param {{ get: Function, save: Function }} deps.settings
 * @param {() => { projects: object[], chats: object[] }} deps.workspace  the current user's own lists
 * @param {{ get: () => object, save: (value:object) => object }} [deps.preferences]  the current user's own framing preferences
 * @param {(userId:string) => boolean} [deps.rateLimited]  true when this user is over the suggest budget (#760)
 */
function createChatFramingRoutes({ json, readJson, framing, settings, workspace, preferences, rateLimited = () => false }) {
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
    if (path === '/api/chat-framing/preferences' && preferences) {
      if (!authn) return json(res, 401, { error: 'Sign in required' }), true;
      if (!['GET', 'PUT'].includes(req.method)) return json(res, 405, { error: 'method not allowed' }), true;
      try {
        return json(res, 200, req.method === 'GET' ? preferences.get() : preferences.save(await readJson(req))), true;
      } catch (error) { return json(res, error.status || 400, { error: error.status ? error.message : 'Invalid framing preferences' }), true; }
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

module.exports = { createChatFramingRoutes };
