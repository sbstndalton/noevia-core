'use strict';
// sbstndalton/noevia#2185: the Rust front answers the Diary routes that are only a proxy to the
// Diary sidecar plus a policy (noevia-rs crates/server-diary): the month list, a day or month of the
// log, the storage import, and the workspace export and import. A direct Node request for one is
// refused before authentication and before the inference gate, whoever asks, so the sidecar is only
// ever reached by the front's signed requests and a stale route table cannot make two processes answer.
//
// What stays here, and why (each reads this process's memory or its own table):
//   /api/diary/context          the project list (PROJECTS), created on first use
//   /api/diary/exchanges        the set of running exchange jobs (diary-jobs.cjs `active`)
//   /api/diary/local-exchange   the model throttle shared with chat (llmRateLimited) and the inference gate
//   /api/diary/storage-status   the storage-login latch (storage-latch.cjs), written by the backup worker
//   /api/diary-connector, /api/profile/diary-connectors   the diary_connectors table, its throttles and audit
// and the paths the web client does not name (/api/diary/history, files, file, workspace-trash,
// external-sources, entries/edit), which the front's route table does not list.
//
// The list is exactly noevia-rs contracts/http/routes.toml's owner = "rust" entries under /api/diary/
// (every method: each route answers its own 405 after the add-on gate, as Node did).
const OWNED_PATHS = Object.freeze([
  '/api/diary/source',
  '/api/diary/today',
  '/api/diary/storage-import',
  '/api/diary/workspace-export',
  '/api/diary/workspace-import',
]);
const ROUTE_REFUSAL = Object.freeze({ error: 'Diary corpus reads, storage import and workspace transfer are owned by the Rust front.', code: 'RUST_DIARY_OWNED' });

/** True for the exact pathnames the front owns (core compared `p === '/api/diary/...'`, so no trailing slash). */
const owned = (pathname) => OWNED_PATHS.includes(pathname);

/**
 * Runs before authentication, the maintenance gate and the workspace load (index.cjs
 * handleRequestInner). `parseRequestUrl` is http.cjs's; an unparseable target falls through to the
 * ordinary 400 the request chain gives it.
 */
function refuseOwned(req, res, { parseRequestUrl, json }) {
  const url = parseRequestUrl(req, `http://${req.headers.host || 'localhost'}`) || parseRequestUrl(req);
  if (!url || !owned(url.pathname)) return false;
  json(res, 503, ROUTE_REFUSAL);
  return true;
}

module.exports = { OWNED_PATHS, ROUTE_REFUSAL, owned, refuseOwned };
