'use strict';
// Rust port track R11: with NOEVIA_RUST_MODEL_MANAGER=rust (read by the front and this process alike) the Rust front
// answers the /api/model-manager/* proxy itself (noevia-rs bins/noevia-server model_manager_routes.rs over
// crates/model-manager-proxy): the path checks, the benchmark, delete and section guards, the held models.ini writes,
// the forward to the model manager, the evidence and the delete clean-up. This process then refuses those requests before
// authentication, so a direct request on its port cannot act beside the front. Two stay here: POST
// /api/model-manager/benchmark/sweep (the front relays it: this process's sweep guard holds the maintenance gate for the
// sweep and takes it back after a restart), and exact GET /api/model-manager/models (already the front's,
// rust-model-manager-scan.cjs). Unset (the default), nothing here changes anything.
const SWITCH = 'NOEVIA_RUST_MODEL_MANAGER';
const PREFIX = '/api/model-manager/';
const KEPT = Object.freeze(['POST /api/model-manager/benchmark/sweep']);
const ROUTE_REFUSAL = Object.freeze({ error: 'The model manager proxy is owned by the Rust front.', code: 'RUST_MODEL_MANAGER_OWNED' });

/** Whether the front answers the proxy (the switch is exactly `rust`). */
const frontOwns = (env = process.env) => env[SWITCH] === 'rust';

/** The path as routes/models.cjs judges it: each segment decoded (a segment that does not decode is kept as it is). */
const decoded = (pathname) => pathname.split('/').map((s) => { try { return decodeURIComponent(s); } catch { return s; } }).join('/');

/** True for a request the front answers under the switch (routes/models.cjs tests `p.startsWith('/api/model-manager/')`).
 *  The sweep is kept by its decoded path, as the front relays it (benchmark/sw%65ep is the sweep too). */
const owned = (method, pathname) => typeof pathname === 'string' && pathname.startsWith(PREFIX)
  && !KEPT.includes(`${method} ${decoded(pathname)}`) && !(method === 'GET' && pathname === '/api/model-manager/models');

/** Runs before authentication (index.cjs). An unparseable target falls through. */
function refuseOwned(req, res, { parseRequestUrl, json, env = process.env }) {
  if (!frontOwns(env)) return false;
  const url = parseRequestUrl(req, `http://${req.headers.host || 'localhost'}`) || parseRequestUrl(req);
  if (!url || !owned(req.method || 'GET', url.pathname)) return false;
  json(res, 503, ROUTE_REFUSAL);
  return true;
}

module.exports = { SWITCH, PREFIX, KEPT, ROUTE_REFUSAL, frontOwns, owned, refuseOwned };
