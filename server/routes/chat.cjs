'use strict';
// POST /api/chat -> one streamed reply (chat.cjs).
//
// Returns true when it handled the request. Auth and CSRF run before routes are mounted.
// This file owns only what happens before the loop starts: the shared-endpoint rate limit,
// the request-size cap, JSON parsing, and the Diary add-on gate.

const { isJsonObject } = require('../http.cjs');

/**
 * @param {object} deps
 * @param {(res, status, body) => any} deps.json
 * @param {(req, cap:number) => Promise<string>} deps.readBody   rejects with { status: 413 } over the cap
 * @param {number} deps.bodyCap
 * @param {(userId:string) => boolean} deps.rateLimited
 * @param {(userId:string) => boolean} deps.diaryEnabled
 * @param {(req, res, body, authn) => Promise<any>} deps.handleChat
 */
function createChatRoutes({ json, readBody, bodyCap, rateLimited, diaryEnabled, handleChat }) {
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
    if (body.spaceId === 'diary' && !diaryEnabled(authn.user.id)) return json(res, 404, { error: 'Diary add-on is disabled' }), true;
    await handleChat(req, res, body, authn);
    return true;
  };
}

module.exports = { createChatRoutes };
