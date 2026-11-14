'use strict';
// Rust port track R11: with NOEVIA_RUST_MODEL_WRITES=rust (read by the front and this process alike) the Rust front
// answers PUT /api/models/inference-budget and PUT /api/models/idle-unload (noevia-rs bins/noevia-server
// model_writes_routes.rs over crates/model-writes): it saves the budget's settings row and audit record, and runs the idle
// unload time's model manager write and router reload under the maintenance hold. This process then refuses both PUTs
// before authentication, so a direct request on its port cannot write beside the front. Unset (the default), nothing here
// changes anything: routes/models.cjs answers both as before.
//
// The budget this process enforces is read from the settings row on every use (inference-budget.cjs), so the front's save
// takes effect here at once.
const SWITCH = 'NOEVIA_RUST_MODEL_WRITES';
const OWNED_PATHS = Object.freeze(['/api/models/inference-budget', '/api/models/idle-unload']);
const ROUTE_REFUSAL = Object.freeze({ error: 'The inference budget and idle unload writes are owned by the Rust front.', code: 'RUST_MODEL_WRITES_OWNED' });

/** Whether the front answers the two PUTs (the switch is exactly `rust`). */
const frontOwns = (env = process.env) => env[SWITCH] === 'rust';

/** True for the exact pathnames the front answers (routes/models.cjs compares `p === '/api/models/...'`). */
const owned = (method, pathname) => method === 'PUT' && OWNED_PATHS.includes(pathname);

/** Runs before authentication (index.cjs). An unparseable target falls through. */
function refuseOwned(req, res, { parseRequestUrl, json, env = process.env }) {
  if (req.method !== 'PUT' || !frontOwns(env)) return false;
  const url = parseRequestUrl(req, `http://${req.headers.host || 'localhost'}`) || parseRequestUrl(req);
  if (!url || !owned(req.method, url.pathname)) return false;
  json(res, 503, ROUTE_REFUSAL);
  return true;
}

module.exports = { SWITCH, OWNED_PATHS, ROUTE_REFUSAL, frontOwns, owned, refuseOwned };
