'use strict';
// sbstndalton/noevia#2190 round 5: the Rust front is Sign in with ChatGPT's token broker (noevia-rs
// bins/noevia-server chatgpt_oauth_routes.rs, capability rust-chatgpt-oauth). It answers the device
// sign-in (POST /api/providers/chatgpt/device, /device/poll, /device/cancel) and the account's model
// list (GET /api/providers/chatgpt/models), and it is the only owner of the tokens: the store
// (chatgpt_oauth_tokens, enc:v2 bound to the owner), the single-flight refresh and the catalogue cache.
// Node answered only those methods on those paths, so only they are refused here, before
// authentication: a stale route table cannot make two processes answer. DELETE /api/providers/chatgpt
// stays Node's (it also removes the provider row Node writes) and asks the broker to delete the tokens.
//
// Node's chat keeps the transport (chatgpt-oauth.cjs fetchFor) and asks the broker for an access
// token over the internal store channel (project-store-client.cjs chatgptSession); it never sees a
// refresh token. Its database guard (rust-auth.cjs FRONT_TABLES) refuses every Node write of the
// table with RUST_CHATGPT_OAUTH_OWNED, even inside exempt(), except RESEAL_SQL: secrets-rotate.cjs
// re-encrypting the same plaintext under the current key, compare-and-swap on the stored value, so
// it can never undo a sign-in or refresh the broker saved in between.
const ROUTES = Object.freeze({
  '/api/providers/chatgpt/device': 'POST',
  '/api/providers/chatgpt/device/poll': 'POST',
  '/api/providers/chatgpt/device/cancel': 'POST',
  '/api/providers/chatgpt/models': 'GET',
});
const ROUTE_REFUSAL = Object.freeze({ error: 'Sign in with ChatGPT is owned by the Rust front.', code: 'RUST_CHATGPT_OAUTH_OWNED' });
const TABLE = 'chatgpt_oauth_tokens';
// The one Node statement on the table the guard lets run (same plaintext, CAS on the old value).
const RESEAL_SQL = 'UPDATE chatgpt_oauth_tokens SET data_enc=? WHERE user_id=? AND data_enc=?';
// The file the broker rewrites after every change of a token row: its signal invalidates the
// short access-token cache in chatgpt-oauth.cjs.
const SIGNAL_FILE = 'chatgpt-token-changes.json';

/** Whether `method` on the exact `pathname` is the broker's. */
function owned(method, pathname) {
  return Object.hasOwn(ROUTES, pathname) && ROUTES[pathname] === method;
}

function refuseOwned(req, res, { parseRequestUrl, json }) {
  const url = parseRequestUrl(req, `http://${req.headers.host || 'localhost'}`) || parseRequestUrl(req);
  if (!url || !owned(req.method, url.pathname)) return false;
  json(res, 503, ROUTE_REFUSAL);
  return true;
}

module.exports = { ROUTES, ROUTE_REFUSAL, TABLE, RESEAL_SQL, SIGNAL_FILE, owned, refuseOwned };
