'use strict';
// sbstndalton/noevia#2257 (group rust-task-reads): the reads of the Code and Browser tasks are the Rust front's
// (noevia-rs bins/noevia-server task_routes.rs, crates/server-projects task_journals.rs). Node keeps the POSTs, the
// tasks themselves and every journal write; the active list's other methods were only ever its 405, so that path is
// the front's for every method.
//
// A direct Node request is refused before authentication, whoever asks, so a stale route table cannot make two
// processes answer. What only this process knows is on the front's loopback call (rust-task-facts.cjs).
//
// path-patterns in routes.toml's spelling, for noevia's deploy/tools/assemble-release.sh.
const OWNED_ROUTES = Object.freeze(new Set([
  'ALL /api/code/active',
  'GET /api/projects/{projectId}/code',
  'GET /api/projects/{projectId}/code/{task}',
  'GET /api/projects/{projectId}/browser',
  'GET /api/projects/{projectId}/browser/{task}',
]));
const READ = /^\/api\/projects\/[^/]+\/(?:code|browser)(?:\/[0-9a-f-]{36})?$/;
const ROUTE_REFUSAL = Object.freeze({ error: 'The Code and Browser task reads are owned by the Rust front.', code: 'RUST_TASK_READS_OWNED' });

/** True for an owned method and path (WHATWG pathname). */
const owned = (method, pathname) => pathname === '/api/code/active' || (method === 'GET' && READ.test(String(pathname)));

/** Runs before authentication and the workspace load (index.cjs). An unparseable target falls through. */
function refuseOwned(req, res, { parseRequestUrl, json }) {
  const url = parseRequestUrl(req);
  if (!url || !owned(req.method, url.pathname)) return false;
  json(res, 503, ROUTE_REFUSAL);
  return true;
}

module.exports = { OWNED_ROUTES, ROUTE_REFUSAL, owned, refuseOwned };
