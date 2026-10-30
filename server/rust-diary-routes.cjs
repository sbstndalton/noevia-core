'use strict';
// sbstndalton/noevia#2206: the Rust front answers the rest of the Diary routes the web client names
// (noevia-rs bins/noevia-server diary_routes.rs and crates/server-diary, capability
// rust-diary-routes), after the five proxy-only ones of #2185 (rust-diary.cjs). A direct Node request
// for one is refused before authentication, whoever asks, so a stale route table cannot make two
// processes answer. Node answered exactly these methods on these paths, so only they are refused:
//
//   /api/diary                          every method (Node had no handler: its unknown-path answer)
//   /api/diary-connector                every method (POST needs the connector's credential, no session)
//   /api/diary/storage-status           every method (the sidecar's status plus the storage-login latch)
//   /api/diary/context                  GET, POST (the Diary attachments project)
//   /api/diary/exchanges                GET, POST (the recovery records and their dismissal)
//   /api/profile/diary-connectors       GET, POST (the connector credentials)
//   /api/profile/diary-connectors/{id}  DELETE
//
// What stays Node's, and why: POST /api/diary/local-exchange takes the model throttle that chat shares
// (llmRateLimited) and, from index.cjs handleRequest, the inference maintenance gate for the whole life
// of its response (llamacpp-manager `maintenance`), so that a preset apply or a tune waits for it.
// Both are this process's memory, beside the chat turn that takes them. The paths the web client does
// not name (history, files, file, workspace-trash, external-sources, entries/edit) are not in the
// front's route table either.
//
// What this process still does for the moved routes:
//   - diary-jobs.cjs publishes which exchanges are running (SIGNAL below) before it writes a record
//     and after its last write; the front's listing and dismissal read it. A set written by another
//     container start (NOEVIA_START_ID) names nothing.
//   - the diary_connectors table is the front's alone (rust-auth.cjs FRONT_TABLES); this process only
//     creates it at boot (diary-connectors.cjs), in the shape a rollback reads.
//   - the Diary attachments project is read through the project store like every project (chat reads
//     `getProject(diaryExtras.PROJECT_ID)`).
const ALL = null;
const ONE_SEGMENT = /^\/api\/profile\/diary-connectors\/[^/]+$/;
const FIXED = Object.freeze({
  '/api/diary': ALL,
  '/api/diary-connector': ALL,
  '/api/diary/storage-status': ALL,
  '/api/diary/context': Object.freeze(['GET', 'POST']),
  '/api/diary/exchanges': Object.freeze(['GET', 'POST']),
  '/api/profile/diary-connectors': Object.freeze(['GET', 'POST']),
});
const ROUTE_REFUSAL = Object.freeze({ error: 'These Diary routes are owned by the Rust front.', code: 'RUST_DIARY_ROUTES_OWNED' });
/** The published set of running exchanges, in each account's `diary-conversations` directory (diary-jobs.cjs writes it). */
const SIGNAL = 'active.json';
/** The table the front alone writes. */
const TABLE = 'diary_connectors';

/** Whether `method` on the exact `pathname` is the front's (core compared `p === '...'`, so no trailing slash). */
function owned(method, pathname) {
  const m = String(method || 'GET').toUpperCase();
  if (Object.hasOwn(FIXED, pathname)) return FIXED[pathname] === ALL || FIXED[pathname].includes(m);
  return ONE_SEGMENT.test(pathname) && m === 'DELETE';
}

/**
 * Runs before authentication, the maintenance gate and the workspace load (index.cjs
 * handleRequestInner). An unparseable target falls through to the ordinary 400 the chain gives it.
 */
function refuseOwned(req, res, { parseRequestUrl, json }) {
  const url = parseRequestUrl(req, `http://${req.headers.host || 'localhost'}`) || parseRequestUrl(req);
  if (!url || !owned(req.method, url.pathname)) return false;
  json(res, 503, ROUTE_REFUSAL);
  return true;
}

module.exports = { FIXED, ROUTE_REFUSAL, SIGNAL, TABLE, owned, refuseOwned };
