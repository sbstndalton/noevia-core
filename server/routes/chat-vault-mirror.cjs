'use strict';
// Chat framing, phase 5 (#741):
//   GET/PUT /api/chat-vault-mirror/preferences { enabled }   signed-in user, their own setting
// "Mirror chats to Diary" is off unless the user turns it on. Turning it on mirrors the user's own
// chats at once; turning it off stops writes (notes already written stay, the mirror is one-way).
// `available` says whether it can run at all: the chatFraming feature and the user's Diary add-on.
// Returns true when it handled the request. Auth and CSRF run before routes are mounted.

/**
 * @param {object} deps
 * @param {{ get: () => {enabled:boolean}, save: (value:object) => {enabled:boolean} }} deps.preferences  the current user's own
 * @param {(userId:string) => boolean} deps.available
 * @param {(userId:string, chatId:string|null, opts?:object) => void} deps.schedule
 */
function createChatVaultMirrorRoutes({ json, readJson, preferences, available, schedule, audit = () => {} }) {
  return async function chatVaultMirrorRoutes(req, res, { path, authn }) {
    if (path !== '/api/chat-vault-mirror/preferences') return false;
    if (!authn) return json(res, 401, { error: 'Sign in required' }), true;
    if (!['GET', 'PUT'].includes(req.method)) return json(res, 405, { error: 'method not allowed' }), true;
    const userId = authn.user.id;
    try {
      if (req.method === 'GET') return json(res, 200, { ...preferences.get(), available: available(userId) }), true;
      const saved = preferences.save(await readJson(req));
      audit('chat-vault-mirror.preferences', userId, { enabled: saved.enabled });
      if (saved.enabled && available(userId)) schedule(userId, null, { immediate: true });
      return json(res, 200, { ...saved, available: available(userId) }), true;
    } catch (error) { return json(res, error.status || 400, { error: error.status ? error.message : 'Invalid mirror preferences' }), true; }
  };
}

module.exports = { createChatVaultMirrorRoutes };
