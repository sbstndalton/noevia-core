'use strict';
// sbstndalton/noevia#2191 round 6 (group rust-source-jobs): the Rust front is the one owning
// process of the source-job store (noevia-rs crates/server-projects source_jobs.rs; served by
// bins/noevia-server source_job_routes.rs). It answers:
//
//   POST /api/projects/{id}/upload?background=1        start a source job (202 { poll })
//   POST /api/projects/{id}/sources/sync?background=1  the same for a folder sync
//   GET  /api/projects/{id}/source-jobs/{jobId}        a job's status
//
// and runs each job's operation by sending the synchronous route to this process with
// `X-Noevia-Source-Work: 1` (routes/projects.cjs answers it as NDJSON progress). Node keeps no
// source journal client: a background start or a poll reaching it directly is refused before
// authentication, whoever asks, so no second process can own a source job. The synchronous
// POST (no `background=1`) is still answered here; it is the front's worker call.
//
// METHOD path-pattern in routes.toml's spelling, for noevia's deploy/tools/assemble-release.sh.
// For the two POSTs, only the `background=1` form is the front's own answer.
const OWNED_ROUTES = Object.freeze(new Set([
  'POST /api/projects/{id}/upload',
  'POST /api/projects/{id}/sources/sync',
  'GET /api/projects/{id}/source-jobs/{jobId}',
]));
// routes/projects.cjs's own matchers, as they were.
const BACKGROUND = /^\/api\/projects\/[^/]+\/(upload|sources\/sync)$/;
const POLL = /^\/api\/projects\/[^/]+\/source-jobs\/[^/]+$/;
const ROUTE_REFUSAL = Object.freeze({ error: 'Background source processing is owned by the Rust front.', code: 'RUST_SOURCE_JOBS_OWNED' });

/** True for a background start (`background=1`, as URLSearchParams reads it) or a poll. */
const owned = (method, pathname, searchParams) => (method === 'GET' && POLL.test(String(pathname)))
  || (method === 'POST' && BACKGROUND.test(String(pathname)) && searchParams?.get?.('background') === '1');

/** Runs before authentication and the workspace load (index.cjs). An unparseable target falls through. */
function refuseOwned(req, res, { parseRequestUrl, json }) {
  if (req.method !== 'POST' && req.method !== 'GET') return false;
  const url = parseRequestUrl(req, `http://${req.headers.host || 'localhost'}`) || parseRequestUrl(req);
  if (!url || !owned(req.method, url.pathname, url.searchParams)) return false;
  json(res, 503, ROUTE_REFUSAL);
  return true;
}

module.exports = { OWNED_ROUTES, ROUTE_REFUSAL, owned, refuseOwned };
