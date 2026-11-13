'use strict';
// The Diary local exchange (/api/diary/local-exchange) is the Rust front's (noevia-rs
// bins/noevia-server diary_routes.rs and crates/server-diary local_exchange, capability
// rust-diary-local-exchange): the add-on gate, the 16 MiB body, the relay of the companion's event
// stream (the policy of diary-stream.cjs) and the non-streamed reply. A direct Node request for it is
// refused before authentication and before the inference gate, for every method, so a stale route
// table cannot make two processes answer.
//
// What stays in this process is what the exchange holds while it runs: the inference
// maintenance gate (with the long-document backfill's pause). The front takes them through its admission
// lease (inference-admission-lease.cjs, ask `{ diaryExchange: { user } }`) before the first byte to the
// sidecar and gives them back when its response ends, so a preset apply, a calibration or a tune still
// waits for the exchange. The front counts the one `llm:` budget per account that chat and the Diary
// share (rust-chat-edge.cjs).
const PATH = '/api/diary/local-exchange';
const ROUTE_REFUSAL = Object.freeze({ error: 'The Diary local exchange is owned by the Rust front.', code: 'RUST_DIARY_LOCAL_EXCHANGE_OWNED' });

/** The exact pathname (core compared `p === '/api/diary/local-exchange'`, so no trailing slash). */
const owned = (pathname) => pathname === PATH;

/**
 * Runs before authentication, the maintenance gate and the workspace load (index.cjs
 * handleRequestInner). An unparseable target falls through to the ordinary 400 the chain gives it.
 */
function refuseOwned(req, res, { parseRequestUrl, json }) {
  const url = parseRequestUrl(req, `http://${req.headers.host || 'localhost'}`) || parseRequestUrl(req);
  if (!url || !owned(url.pathname)) return false;
  json(res, 503, ROUTE_REFUSAL);
  return true;
}

module.exports = { PATH, ROUTE_REFUSAL, owned, refuseOwned };
