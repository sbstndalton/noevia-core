'use strict';
// sbstndalton/noevia#2190: the Rust front answers every method of /api/admin/decision-settings and
// /api/admin/decision-settings/test (noevia-rs bins/noevia-server decision_settings_routes.rs) and is
// the single writer of the `decision:configuration` settings row (rust-auth.cjs refuses the key on
// this connection). Node answered every method of both paths (405 for the others), so every method
// is refused here, before authentication: a stale route table cannot make two processes answer.
//
// Node keeps the decision path in process: decision-settings.cjs re-reads the row by its content
// fingerprint on every use (shared-reread.cjs), so Rust's latest save is in force for the next
// decision without a restart.
const OWNED_PATHS = Object.freeze(['/api/admin/decision-settings', '/api/admin/decision-settings/test']);
const ROUTE_REFUSAL = Object.freeze({ error: 'Decision settings are owned by the Rust front.', code: 'RUST_DECISION_SETTINGS_OWNED' });

/** The exact pathnames, every method (core compared both paths exactly). */
const owned = (pathname) => OWNED_PATHS.includes(pathname);

function refuseOwned(req, res, { parseRequestUrl, json }) {
  const url = parseRequestUrl(req, `http://${req.headers.host || 'localhost'}`) || parseRequestUrl(req);
  if (!url || !owned(url.pathname)) return false;
  json(res, 503, ROUTE_REFUSAL);
  return true;
}

module.exports = { OWNED_PATHS, ROUTE_REFUSAL, owned, refuseOwned };
