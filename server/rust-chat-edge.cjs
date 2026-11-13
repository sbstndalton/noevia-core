'use strict';
// Chat port S6: the chat edge is the Rust front's (noevia-rs bins/noevia-server chat_edge.rs, capability
// rust-chat-edge). The front answers what routes/chat.cjs answered before a turn reached the loop:
//
//   the `llm:<user>` budget (LLM_RATE_LIMIT a minute, default 60), 429 before the body is read;
//   the body cap (STORED_HISTORY_BYTES), 413, or 400 for a failed read;
//   400 invalid JSON, 400 not an object, chat-mode.cjs requestShapeError;
//   Cowork: 403 not an administrator, 409 the harness off, 409 outside a project;
//   404 `spaceId: 'diary'` with the add-on off.
//
// The budget is the one POST /api/diary/local-exchange shares: the front counts that call too (after this process's
// add-on and method checks would have passed) and answers its 429. So this process keeps no `llm:` limiter at all
// (index.cjs; routes/chat.cjs and routes/diary.cjs take none); counting here too would charge each call twice.
//
// Node's order is the inference gate first, then the budget: a call is counted only once the gate let it in, and in
// the order the gate let calls in. So the front takes the gate before it counts anything, and keeps it while it
// answers its refusals and for the call it sends (since chat port S8 with an admission lease, rust-chat-admission.cjs;
// in S6 with a hold on POST /internal/chat/gate). Nothing is ever given back to the budget: the front only counts
// calls the gate let in.
//
// A Cowork start that passes is sent to POST /internal/chat/cowork (rust-chat-turn.cjs accepts it as a relayed turn,
// so authentication as the front's user and routes/chat.cjs run unchanged and answer the 202). The rest of
// routes/chat.cjs's checks stay here: a request the front passed passes them too, and a front that could not read a
// fact (the code harness flag) leaves the answer to them.

// The front capability this module pairs with, for the launch supervisor and assemble-release.
const FRONT_CAPABILITY = 'rust-chat-edge';
const COWORK_PATH = '/internal/chat/cowork';
const LOCAL_EXCHANGE = '/api/diary/local-exchange';

module.exports = { FRONT_CAPABILITY, COWORK_PATH, LOCAL_EXCHANGE };
