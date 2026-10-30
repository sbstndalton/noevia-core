'use strict';
// sbstndalton/noevia#2218 (group rust-research): deep research is the Rust front's (noevia-rs crates/research-core,
// bins/noevia-server research_routes.rs): every method of these paths, because Node's matcher took them all:
//
//   POST /api/projects/{projectId}/research/plan
//   GET, POST /api/projects/{projectId}/research
//   GET  /api/projects/{projectId}/research/{job}
//   POST /api/projects/{projectId}/research/{job}/cancel
//   POST /api/projects/{projectId}/research/{job}/save
//
// A direct Node request is refused before authentication, whoever asks, so a stale route table cannot make two
// processes answer. What the job still needs from this process stays behind the front's own loopback calls
// (rust-research-bridge.cjs, inference-admission-lease.cjs).
//
// ALL (every method, as Node's matcher took them) path-pattern in routes.toml's spelling, for noevia's deploy/tools/assemble-release.sh.
const OWNED_ROUTES = Object.freeze(new Set([
  'ALL /api/projects/{projectId}/research',
  'ALL /api/projects/{projectId}/research/plan',
  'ALL /api/projects/{projectId}/research/{job}',
  'ALL /api/projects/{projectId}/research/{job}/cancel',
  'ALL /api/projects/{projectId}/research/{job}/save',
]));
// The old routes/research.cjs matcher, whatever the method; anything else under the prefix was never research's.
const PATTERN = /^\/api\/projects\/[^/]+\/research(?:\/(plan|[0-9a-f-]{36}))?(?:\/(cancel|save))?$/;
const ROUTE_REFUSAL = Object.freeze({ error: 'Deep research is owned by the Rust front.', code: 'RUST_RESEARCH_OWNED' });

/** True for the owned path (WHATWG pathname), any method. */
const owned = (_method, pathname) => PATTERN.test(String(pathname));

/** Runs before authentication and the workspace load (index.cjs). An unparseable target falls through. */
function refuseOwned(req, res, { parseRequestUrl, json }) {
  const url = parseRequestUrl(req);
  if (!url || !owned(req.method, url.pathname)) return false;
  json(res, 503, ROUTE_REFUSAL);
  return true;
}

module.exports = { OWNED_ROUTES, ROUTE_REFUSAL, owned, refuseOwned };
