'use strict';
// Chat port S4: POST /api/chat-framing/suggest is the Rust front's (noevia-rs bins/noevia-server
// chat_framing_suggest.rs, capability rust-chat-framing-suggest). The front owns the public route: the
// session gate (401, CSRF, browser-only), 405 for the other methods, the 10-a-minute `chat-frame:<user>`
// budget (429 {frame:null, reason:'rate-limited'}), the body (400 `Invalid request` / `message
// required`) and the cut to 4,000 UTF-16 units. What it cannot do is this process's: the user's lists
// as the workspace load gives them, and the decision service. So it calls, on loopback with the
// per-start secret,
//
//   POST /internal/chat-framing/suggest {user, message, chatId}  -> 200 {frame|null, reason}
//
// and answers what this returns, byte for byte; any other answer (or none) is its fail-open
// 200 {frame:null, reason:'error'}. The lists are built as that user, as routes/chat-framing.cjs built
// them for a signed-in request: only Chat-mode, unarchived, non-internal projects are offered, every
// own chat counts. A workspace that cannot be read is 200 {frame:null, reason:'error'}, as before.
//
// The public POST is refused here before authentication, whoever asks, so a stale route table cannot
// make two processes answer. Other methods keep Node's gate and its signed-in 405 (routes/chat-framing.cjs):
// several tests use that GET as a cheap authenticated probe.
const { trustedFront } = require('./trusted-front.cjs');

// The route in routes.toml's spelling, for noevia's deploy/tools/assemble-release.sh.
const OWNED_ROUTES = Object.freeze(new Set(['POST /api/chat-framing/suggest']));
const ROUTE_REFUSAL = Object.freeze({ error: 'Chat framing suggestions are owned by the Rust front.', code: 'RUST_CHAT_FRAMING_SUGGEST_OWNED' });
const PATH = '/api/chat-framing/suggest';
const BRIDGE_PATH = '/internal/chat-framing/suggest';
/** The front cuts the message to this many UTF-16 units (`message.slice(0, 4000)`). */
const MESSAGE_CAP = 4000;
/** The longest user id the bridge takes (UTF-16 units). Account ids are far shorter. */
const USER_CAP = 1024;
/** The front's public body limit: http.cjs readBody's default. */
const PUBLIC_BODY_LIMIT = 1024 * 1024;
/**
 * The bridge's own body limit. The front re-sends a public body of at most PUBLIC_BODY_LIMIT bytes as
 * {user, message, chatId}: the chat id is a span of that body after UTF-8 replacement (an invalid byte
 * becomes U+FFFD, three bytes), so at most 3 x PUBLIC_BODY_LIMIT; the message is at most MESSAGE_CAP units,
 * the user at most USER_CAP, each up to six bytes a unit when escaped, plus the JSON framing. All of that
 * fits in 64 KiB over the chat id's bound. The default 1 MiB would refuse a valid public request.
 */
const ENVELOPE_LIMIT = 64 * 1024;
const BRIDGE_BODY_LIMIT = 3 * PUBLIC_BODY_LIMIT + ENVELOPE_LIMIT;

const owned = (method, pathname) => method === 'POST' && pathname === PATH;

/** Runs before authentication and the workspace load (index.cjs). An unparseable target falls through. */
function refuseOwned(req, res, { parseRequestUrl, json }) {
  const url = parseRequestUrl(req);
  if (!url || !owned(req.method, url.pathname)) return false;
  json(res, 503, ROUTE_REFUSAL);
  return true;
}

/**
 * The front's loopback call. Anything not from the front gets the 404 of an unknown path, because with
 * file sharing on this listener is not bound to loopback alone.
 * @param {object} deps
 * @param {(userId: string, fn: Function) => Promise<any>} deps.asUser  runs fn with that user's workspace
 * @param {{ suggest: Function }} deps.framing
 * @param {() => { projects: object[], chats: object[] }} deps.workspace  the current user's own lists
 */
function createSuggestBridge({ secret, asUser, framing, workspace, json, readJson, log = (m) => console.warn(m) }) {
  return async function handle(req, res) {
    if (String(req.url || '').split('?')[0] !== BRIDGE_PATH) return false;
    if (!trustedFront(req, secret) || req.method !== 'POST') { json(res, 404, { error: 'Not found' }); return true; }
    let body;
    try { body = await readJson(req, BRIDGE_BODY_LIMIT); } catch { json(res, 400, { error: 'invalid JSON' }); return true; }
    const { user, message, chatId } = body || {};
    if (typeof user !== 'string' || !user || user.length > USER_CAP || typeof message !== 'string' || message.length > MESSAGE_CAP || (chatId !== null && typeof chatId !== 'string')) {
      json(res, 400, { error: 'A user, a message and a chat id or null are required.' });
      return true;
    }
    try {
      const result = await asUser(user, async () => {
        let lists;
        try { lists = workspace(); } catch { return { frame: null, reason: 'error' }; }
        return framing.suggest({ message, chatId, projects: lists.projects, chats: lists.chats });
      });
      json(res, 200, result);
    } catch (e) {
      log(`[chat-framing] suggest bridge failed: ${e?.code || e?.name || 'error'}`);
      json(res, 502, { error: 'The suggestion could not be made.' });
    }
    return true;
  };
}

module.exports = { OWNED_ROUTES, ROUTE_REFUSAL, PATH, BRIDGE_PATH, MESSAGE_CAP, USER_CAP, PUBLIC_BODY_LIMIT, BRIDGE_BODY_LIMIT, owned, refuseOwned, createSuggestBridge };
