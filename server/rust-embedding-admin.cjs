'use strict';
// Rust port track R11: with NOEVIA_RUST_EMBEDDING_ADMIN=rust (read by the front and this process alike) the Rust front
// answers /api/embedding (noevia-rs bins/noevia-server, over crates/embedding-migration and crates/embedding-admin): the
// status, the five migration actions and the two service actions, writing embedding-config.json itself under its
// publication lock. This process then refuses that path before authentication, whatever the method, so a direct request
// on its port cannot change the configuration beside the front, and reads embedding-config.json again whenever the file
// changes (embedding-config.cjs `reread`), so retrieval and the delete guard follow the front's change at once. Unset
// (the default), nothing here changes anything: routes/embedding.cjs answers as before and the file is read at start-up.
const SWITCH = 'NOEVIA_RUST_EMBEDDING_ADMIN';
const OWNED_PATH = '/api/embedding';
const ROUTE_REFUSAL = Object.freeze({ error: 'The embedding settings are owned by the Rust front.', code: 'RUST_EMBEDDING_ADMIN_OWNED' });

/** Whether the front answers /api/embedding (the switch is exactly `rust`). */
const frontOwns = (env = process.env) => env[SWITCH] === 'rust';

/** True for the exact pathname the front answers (routes/embedding.cjs compares `p !== '/api/embedding'`), any method. */
const owned = (pathname) => pathname === OWNED_PATH;

/** Runs before authentication (index.cjs). An unparseable target falls through. */
function refuseOwned(req, res, { parseRequestUrl, json, env = process.env }) {
  if (!frontOwns(env)) return false;
  const url = parseRequestUrl(req, `http://${req.headers.host || 'localhost'}`) || parseRequestUrl(req);
  if (!url || !owned(url.pathname)) return false;
  json(res, 503, ROUTE_REFUSAL);
  return true;
}

module.exports = { SWITCH, OWNED_PATH, ROUTE_REFUSAL, frontOwns, owned, refuseOwned };
