'use strict';
// sbstndalton/noevia#2190 round 7: the Rust front runs the off-site backup (noevia-rs bins/noevia-server
// offsite_*.rs, capability rust-offsite-backup): the eight /api/admin/offsite-backup routes, the jobs,
// the nightly schedule (outside the appdata and NAS windows), the status file, the snapshot store and the
// copy to Google Drive. Node answered every method of those exact paths (403 for a non-administrator,
// 405 for the wrong method), so every method is refused here, before authentication: a stale route table
// cannot make two processes answer. Node has no backup code left.
const OWNED_PATHS = Object.freeze([
  '/api/admin/offsite-backup',
  '/api/admin/offsite-backup/copy',
  '/api/admin/offsite-backup/google/connect',
  '/api/admin/offsite-backup/google/disconnect',
  '/api/admin/offsite-backup/new-store',
  '/api/admin/offsite-backup/recovery-key',
  '/api/admin/offsite-backup/run',
  '/api/admin/offsite-backup/verify',
]);
const ROUTE_REFUSAL = Object.freeze({ error: 'The off-site backup is owned by the Rust front.', code: 'RUST_OFFSITE_BACKUP_OWNED' });

/** The exact pathnames, every method. */
const owned = (pathname) => OWNED_PATHS.includes(pathname);

function refuseOwned(req, res, { parseRequestUrl, json }) {
  const url = parseRequestUrl(req, `http://${req.headers.host || 'localhost'}`) || parseRequestUrl(req);
  if (!url || !owned(url.pathname)) return false;
  json(res, 503, ROUTE_REFUSAL);
  return true;
}

module.exports = { OWNED_PATHS, ROUTE_REFUSAL, owned, refuseOwned };
