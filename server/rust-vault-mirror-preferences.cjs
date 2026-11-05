'use strict';
// sbstndalton/noevia#2190 round 3: the Rust front answers GET|PUT /api/chat-vault-mirror/preferences
// (noevia-rs crates/server-account vault_mirror.rs) and is the only writer of
// users/<id>/chat-vault-mirror.json; the mirror (the front's too, crates/chat-mirror-exec) reads it on every use
// (server-account vault_mirror exec_gates). Node's route answered every method on the exact path
// (405 for the others), so every method is refused here, before authentication: a stale route
// table cannot make two processes answer.
//
// Node's PUT scheduled the account's mirror at once when it turned the mirror on. The mirror's schedule is
// the Rust front's now (rust-chat-mirror.cjs, capability rust-chat-mirror-v1): a save that turns it on nudges
// that schedule in process, and this process only does the pass (its own enabled(userId) gate applies).
const PATH = '/api/chat-vault-mirror/preferences';
const ROUTE_REFUSAL = Object.freeze({ error: 'Chat vault mirror preferences are owned by the Rust front.', code: 'RUST_VAULT_MIRROR_PREFERENCES_OWNED' });
function refuseOwned(req, res, { parseRequestUrl, json }) {
  const url = parseRequestUrl(req, `http://${req.headers.host || 'localhost'}`) || parseRequestUrl(req);
  if (!url || url.pathname !== PATH) return false;
  json(res, 503, ROUTE_REFUSAL);
  return true;
}

module.exports = { PATH, ROUTE_REFUSAL, refuseOwned };
