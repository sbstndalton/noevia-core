'use strict';
// Chat port S6: the chat edge is the Rust front's (noevia-rs bins/noevia-server chat_edge.rs, capability
// rust-chat-edge). The front answers what routes/chat.cjs answered before a turn reached the loop, each after this
// process's inference gate (it asks POST /internal/chat/gate first, as for its 401/403):
//
//   the `llm:<user>` budget (LLM_RATE_LIMIT a minute, default 60), 429 before the body is read;
//   the body cap (STORED_HISTORY_BYTES), 413, or 400 for a failed read;
//   400 invalid JSON, 400 not an object, chat-mode.cjs requestShapeError;
//   Cowork: 403 not an administrator, 409 the harness off, 409 outside a project;
//   404 `spaceId: 'diary'` with the add-on off.
//
// The budget is the one POST /api/diary/local-exchange shares: the front counts that call too (after this
// process's add-on and method checks would have passed) and answers its 429. So this process keeps no `llm:`
// limiter at all (index.cjs; routes/chat.cjs and routes/diary.cjs take none); counting here too would charge each
// call twice.
//
// A Cowork start that passes is sent to POST /internal/chat/cowork (rust-chat-turn.cjs accepts it as a relayed turn,
// so the gate, authentication as the front's user and routes/chat.cjs run unchanged and answer the 202). The rest of
// routes/chat.cjs's checks stay here: a request the front passed passes them too, and a front that could not read a
// fact (the code harness flag) leaves the answer to them.
//
// A call this process's gate refused was never counted by Node. The front counted it before relaying, so the gate's
// refusal of a relayed call, or of a Diary local exchange, carries GATE_REFUSED_HEADER and the front gives the call
// back. The front removes the header; the client never sees it.
//
// The gate probe for the local exchange is POST /internal/chat/gate?route=diary-local-exchange: the request then
// meets the gate as POST /api/diary/local-exchange does, and a refusal is that route's (`{error}`, no Retry-After).

// The front capability this module pairs with, for the launch supervisor and assemble-release.
const FRONT_CAPABILITY = 'rust-chat-edge';
const COWORK_PATH = '/internal/chat/cowork';
const GATE_REFUSED_HEADER = 'x-noevia-gate-refused';
const DIARY_GATE_ROUTE = 'diary-local-exchange';
const LOCAL_EXCHANGE = '/api/diary/local-exchange';

/** Whether the gate's refusal of this request is one the front counted (a relayed call, or the local exchange). */
function countedByFront(relay, pathname) {
  return !!relay || pathname === LOCAL_EXCHANGE;
}

/** Marks the gate's refusal for the front, before the refusal is written. */
function markGateRefused(res, relay, pathname) {
  if (countedByFront(relay, pathname)) res.setHeader(GATE_REFUSED_HEADER, '1');
}

module.exports = { FRONT_CAPABILITY, COWORK_PATH, GATE_REFUSED_HEADER, DIARY_GATE_ROUTE, LOCAL_EXCHANGE, countedByFront, markGateRefused };
