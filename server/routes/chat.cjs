'use strict';
// POST /api/chat -> one streamed reply (chat.cjs), or, for a Cowork session, one code task.
//
// Returns true when it handled the request. Auth and CSRF run before routes are mounted.
// This file owns only what happens before the loop starts: the shared-endpoint rate limit,
// the request-size cap, JSON parsing, the request shape (`mode`, `turnToolboxes`), the Diary
// add-on gate, and the Cowork guard (chat-mode.cjs).

const { isJsonObject } = require('../http.cjs');
const { requestShapeError, coworkRefusal } = require('../chat-mode.cjs');

/**
 * @param {object} deps
 * @param {(res, status, body) => any} deps.json
 * @param {(req, cap:number) => Promise<string>} deps.readBody   rejects with { status: 413 } over the cap
 * @param {number} deps.bodyCap
 * @param {(userId:string) => boolean} deps.rateLimited
 * @param {(userId:string) => boolean} deps.diaryEnabled
 * @param {(req, res, body, authn) => Promise<any>} deps.handleChat
 * @param {() => boolean} [deps.harnessEnabled]  features.codeHarness, read per request
 * @param {(body, authn) => Promise<object>} [deps.startCoworkTask]  the existing code task start;
 *        throws { status, publicMessage } like code-service.cjs does
 */
function createChatRoutes({ json, readBody, bodyCap, rateLimited, diaryEnabled, handleChat, harnessEnabled = () => false, startCoworkTask = null }) {
  return async function chatRoutes(req, res, { path, authn }) {
    if (path !== '/api/chat' || req.method !== 'POST') return false;
    if (rateLimited(authn.user.id)) return json(res, 429, { error: 'Too many requests — the model endpoint is shared; wait a moment and try again' }), true;
    let raw;
    try { raw = await readBody(req, bodyCap); }
    catch (e) { return json(res, e.status || 400, { error: e.status === 413 ? 'This chat is too large to continue; start a new chat.' : 'could not read the request' }), true; }
    let body;
    try { body = JSON.parse(raw); }
    catch { return json(res, 400, { error: 'invalid JSON' }), true; }
    if (!isJsonObject(body)) return json(res, 400, { error: 'request body must be a JSON object' }), true;
    const shape = requestShapeError(body);
    if (shape) return json(res, shape.status, { error: shape.error }), true;
    if (body.mode === 'cowork') {
      const refused = coworkRefusal({ authn, harnessEnabled: harnessEnabled(), projectId: body.projectId }) || (startCoworkTask ? null : { status: 409, error: 'Cowork is not available on this server.' });
      if (refused) return json(res, refused.status, { error: refused.error, mode: 'cowork' }), true;
      try {
        const task = await startCoworkTask(body, authn);
        return json(res, 202, { mode: 'cowork', task }), true;
      } catch (error) {
        return json(res, error.status || 500, { error: error.publicMessage || (error.status ? error.message : 'Cowork task could not start'), mode: 'cowork' }), true;
      }
    }
    if (body.spaceId === 'diary' && !diaryEnabled(authn.user.id)) return json(res, 404, { error: 'Diary add-on is disabled' }), true;
    await handleChat(req, res, body, authn);
    return true;
  };
}

module.exports = { createChatRoutes };
