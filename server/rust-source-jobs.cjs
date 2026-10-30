'use strict';
// sbstndalton/noevia#2191 round 6 (group rust-source-jobs): the Rust front is the one owning
// process of the source-job store (noevia-rs crates/server-projects source_jobs.rs; served by
// bins/noevia-server source_job_routes.rs). It answers:
//
//   POST /api/projects/{id}/upload?background=1        start a source job (202 { poll })
//   POST /api/projects/{id}/sources/sync?background=1  the same for a folder sync
//   GET  /api/projects/{id}/source-jobs/{jobId}        a job's status
//
// and, since round 8, runs each job's operation in the front itself (rust-project-source-work.cjs: the
// operations are the front's, in the foreground too). Node keeps no source journal client: a poll
// reaching it directly is refused before authentication, whoever asks, so no second process can own a
// source job. The two POSTs are refused whole by rust-project-source-work.cjs, which runs first.
//
// METHOD path-pattern in routes.toml's spelling, for noevia's deploy/tools/assemble-release.sh.
const OWNED_ROUTES = Object.freeze(new Set([
  'GET /api/projects/{id}/source-jobs/{jobId}',
]));
// routes/projects.cjs's own matcher, as it was.
const POLL = /^\/api\/projects\/[^/]+\/source-jobs\/[^/]+$/;
const ROUTE_REFUSAL = Object.freeze({ error: 'Background source processing is owned by the Rust front.', code: 'RUST_SOURCE_JOBS_OWNED' });

/** True for a poll. */
const owned = (method, pathname) => method === 'GET' && POLL.test(String(pathname));

/** Runs before authentication and the workspace load (index.cjs). An unparseable target falls through. */
function refuseOwned(req, res, { parseRequestUrl, json }) {
  if (req.method !== 'GET') return false;
  const url = parseRequestUrl(req, `http://${req.headers.host || 'localhost'}`) || parseRequestUrl(req);
  if (!url || !owned(req.method, url.pathname)) return false;
  json(res, 503, ROUTE_REFUSAL);
  return true;
}

module.exports = { OWNED_ROUTES, ROUTE_REFUSAL, owned, refuseOwned };
