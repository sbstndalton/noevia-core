'use strict';
// sbstndalton/noevia#2185: the Rust front answers the Diary routes that are only a proxy to the
// Diary sidecar plus a policy (noevia-rs crates/server-diary): the month list, a day or month of the
// log, the storage import, and the workspace export and import. A direct Node request for one is
// refused before authentication and before the inference gate, whoever asks, so the sidecar is only
// ever reached by the front's signed requests and a stale route table cannot make two processes answer.
//
// The remaining proxies and Diary backup loop move as a pair. Top compares this immutable
// export with the front's compiled feature before either process starts; an environment value
// cannot activate a second worker. Import/edit retain their unmatched-method fallthrough.
const OWNED_PATHS = Object.freeze([
  '/api/diary/files',
  '/api/diary/file',
  '/api/diary/workspace-trash',
  '/api/diary/history',
  '/api/diary/external-sources',
  '/api/diary/external-sources/import',
  '/api/diary/entries/edit',
  '/api/diary/source',
  '/api/diary/today',
  '/api/diary/storage-import',
  '/api/diary/workspace-export',
  '/api/diary/workspace-import',
]);
const ROUTE_REFUSAL = Object.freeze({ error: 'Diary corpus reads, storage import and workspace transfer are owned by the Rust front.', code: 'RUST_DIARY_OWNED' });

/** True for the exact pathnames the front owns (core compared `p === '/api/diary/...'`, so no trailing slash). */
const owned = (pathname, method) => OWNED_PATHS.includes(pathname) && (method === undefined || !['/api/diary/external-sources/import', '/api/diary/entries/edit'].includes(pathname) || method === 'POST');

/**
 * Runs before authentication, the maintenance gate and the workspace load (index.cjs
 * handleRequestInner). `parseRequestUrl` is http.cjs's; an unparseable target falls through to the
 * ordinary 400 the request chain gives it.
 */
function refuseOwned(req, res, { parseRequestUrl, json }) {
  const url = parseRequestUrl(req, `http://${req.headers.host || 'localhost'}`) || parseRequestUrl(req);
  if (!url || !owned(url.pathname, req.method)) return false;
  json(res, 503, ROUTE_REFUSAL);
  return true;
}

const DIARY_BACKUP_WORKER_OWNER = 'noevia-diary-backup-worker-rust/1';
module.exports = { DIARY_BACKUP_WORKER_OWNER, OWNED_PATHS, ROUTE_REFUSAL, owned, refuseOwned };
