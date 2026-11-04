'use strict';
// Chat port S8: chat admission is the Rust front's (noevia-rs bins/noevia-server chat_admission.rs, capability
// rust-chat-admission, through crates/engine-admission). Before a chat turn, a Cowork start or the Diary local exchange
// is counted on the `llm:` budget, the front takes this process's inference gate with an admission lease
// (inference-admission-lease.cjs):
//
//   POST /internal/inference-admission/lease {gate: 'chat' | 'diary'}
//       -> 201 {lease, ttlMs}: the gate entered as that call meets it (chat-admission.cjs enterChatInference: a wait of
//          at most CHAT_GATE_WAIT_MS that ends when the front goes away), held until the front deletes the lease or
//          stops renewing it; or the gate's refusal, 503 {error, code}.
//
// The front answers that refusal itself, as index.cjs answered it (POST /api/chat: 503, `Retry-After: 3`,
// chat-admission.cjs refusalBody and one `[chat] 503 route=/api/chat reason=maintenance` line; the local exchange:
// 503 {error}). The call it then sends carries LEASE_HEADER, and index.cjs skips its own gate entry for a live gate
// lease of that call's route: the front's lease is the call's one gate count (chat.cjs engineBusy reads
// inferenceBusy(1), so a second count would silently stop titles), and the front gives it back when the call's answer
// has ended. A lease covers one call; a call whose lease is not live meets the gate as any request does.
//
// This replaces the S6 gate hold (POST /internal/chat/gate?hold=1, rust-chat-edge.cjs leases) and the front's gate
// probe for a request it refuses (POST /internal/chat/gate): the front now takes the same lease and gives it back.

// The front capability this module pairs with, for the launch supervisor and assemble-release.
const FRONT_CAPABILITY = 'rust-chat-admission';
const LEASE_HEADER = 'x-noevia-admission-lease';
const GATE_ROUTES = Object.freeze(['chat', 'diary']);

module.exports = { FRONT_CAPABILITY, LEASE_HEADER, GATE_ROUTES };
