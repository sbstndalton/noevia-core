'use strict';
// Chat port S5: POST /api/chat is the Rust front's (noevia-rs bins/noevia-server chat_turn.rs, capability
// rust-chat-turn), as a transparent relay. The front answers the session gate (401, CSRF, browser-only) and then
// streams the client's request, unread, to this process's loopback
//
//   POST /internal/chat/turn   x-noevia-store-token: <per-start secret>, x-noevia-chat-user: <the front's user>
//
// which runs the unchanged pipeline as if the request had come straight here: the inference gate (index.cjs
// handleRequest, 503 + Retry-After: 3), authentication of the same credentials, CSRF, the `llm:` budget, the body
// cap (STORED_HISTORY_BYTES, 413), routes/chat.cjs and handleChat. The answer (JSON or the SSE stream, keep-alive
// comments included) goes back byte for byte, and the front closing this socket is the client leaving (#679).
// The credentials must authenticate as the user the front named, or the request is the 401 of a signed-out one.
//
// Core's inference gate answers before authentication, so a request the front refuses (401/403) is first offered
// to the gate alone:
//
//   POST /internal/chat/gate   -> 204 when the gate would let a turn in (the hold is given back at once), or the
//                                 gate's own refusal (503 + Retry-After: 3 + body, one `[chat] 503` line)
//
// and the front answers its refusal only after a 204. The precedence a client sees is Node's.
//
// The front's proxied requests carry the client's address (x-noevia-client-ip, x-forwarded-for), and a request with
// either is never the front's own call (trusted-front.cjs). So the relay carries those two under its own names,
// and they are put back, under their usual names, only once the call is trusted: the pipeline then reads the
// client's address exactly as from the proxy. The secret and the user header are removed before anything else
// reads the request.
//
// The public POST is refused here before the gate and authentication, whoever asks, so a stale route table cannot
// make two processes answer a turn. Other methods are not chat turns and keep Node's answers.
const { trustedFront } = require('./trusted-front.cjs');

// The route in routes.toml's spelling, for noevia's deploy/tools/assemble-release.sh.
const OWNED_ROUTES = Object.freeze(new Set(['POST /api/chat']));
const ROUTE_REFUSAL = Object.freeze({ error: 'Chat turns are owned by the Rust front.', code: 'RUST_CHAT_TURN_OWNED' });
const PATH = '/api/chat';
const TURN_PATH = '/internal/chat/turn';
const GATE_PATH = '/internal/chat/gate';
const TOKEN_HEADER = 'x-noevia-store-token';
const USER_HEADER = 'x-noevia-chat-user';
// The client's address as the front's proxy would have sent it, under names trusted-front.cjs does not refuse.
const RELAY_CLIENT_HEADER = 'x-noevia-relay-client-ip';
const RELAY_FORWARDED_HEADER = 'x-noevia-relay-forwarded-for';
const RELAYED = Symbol('noevia.chatTurnRelay');

const owned = (method, pathname) => method === 'POST' && pathname === PATH;

/** Runs before the gate and authentication (index.cjs). A relayed turn passes; an unparseable target falls through. */
function refuseOwned(req, res, { parseRequestUrl, json }) {
  if (req[RELAYED]) return false;
  const url = parseRequestUrl(req);
  if (!url || !owned(req.method, url.pathname)) return false;
  json(res, 503, ROUTE_REFUSAL);
  return true;
}

/** The user the front authenticated this relayed turn as, or null for any other request. */
function relayedUser(req) {
  return (req && req[RELAYED] && req[RELAYED].user) || null;
}

/**
 * The front's loopback calls. `accept` runs first in index.cjs handleRequest and answers:
 *   null      not a relay path; carry on
 *   'turn'    a trusted turn: req is now POST /api/chat with the client's headers, marked with its user
 *   'gate'    a trusted gate probe: req is now POST /api/chat with no user; answer after the gate
 *   'done'    answered here (anything not from the front gets the 404 of an unknown path, because with file
 *             sharing on this listener is not bound to loopback alone)
 */
function createTurnBridge({ secret, json }) {
  function accept(req, res) {
    const pathname = String(req.url || '').split('?')[0];
    if (pathname !== TURN_PATH && pathname !== GATE_PATH) return null;
    if (!trustedFront(req, secret) || req.method !== 'POST') { json(res, 404, { error: 'Not found' }); return 'done'; }
    const turn = pathname === TURN_PATH;
    const user = req.headers[USER_HEADER];
    if (turn && (typeof user !== 'string' || !user)) { json(res, 400, { error: 'A user is required.' }); return 'done'; }
    const client = req.headers[RELAY_CLIENT_HEADER];
    const forwarded = req.headers[RELAY_FORWARDED_HEADER];
    for (const name of [TOKEN_HEADER, USER_HEADER, RELAY_CLIENT_HEADER, RELAY_FORWARDED_HEADER]) delete req.headers[name];
    if (typeof client === 'string' && client) req.headers['x-noevia-client-ip'] = client;
    if (typeof forwarded === 'string' && forwarded) req.headers['x-forwarded-for'] = forwarded;
    req.url = PATH;
    req[RELAYED] = { user: turn ? user : null };
    return turn ? 'turn' : 'gate';
  }
  return { accept };
}

module.exports = {
  OWNED_ROUTES, ROUTE_REFUSAL, PATH, TURN_PATH, GATE_PATH, TOKEN_HEADER, USER_HEADER, RELAY_CLIENT_HEADER, RELAY_FORWARDED_HEADER,
  owned, refuseOwned, relayedUser, createTurnBridge,
};
