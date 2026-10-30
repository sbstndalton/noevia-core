'use strict';
// sbstndalton/noevia#2191 round 9 (group rust-project-config): the Rust front configures a project and
// manages its instruction skills (noevia-rs crates/server-projects config.rs, instruction_skills.rs and
// skill_routes.rs, served by bins/noevia-server project_routes.rs and project_config_routes.rs):
//
//   POST /api/projects/{projectId}/config                                   the patch of every project field
//   GET  /api/projects/{projectId}/instruction-skills                       the Sources list
//   PUT  /api/projects/{projectId}/instruction-skills                       enable or disable one skill
//   GET  /api/projects/{projectId}/instruction-skills/manifests             the portable manifests
//   GET  /api/projects/{projectId}/instruction-skills/manifests/{id}/content  one enabled skill's text
//   POST /api/projects/{project}/skills/install                             one published SKILL.md
//
// projects.json is the front's to write (the project store, rust-projects.cjs): this process re-reads it at
// each request start, so a chat turn sees a change at once, and the caches that hold a view of a project's
// toolbox selection key on it (index.cjs `cacheKeyExtra`). What chat still needs of this module's old
// handlers stays here as a library (instruction-skills.cjs: `inspect`, `list`, `manifests`, `resolvePinned`,
// `reconcile`, `snapshot`); the toolbox ids the front validates against are published beside the project
// catalogue (project-catalogue.cjs `known`).
//
// A direct Node request is refused before authentication, whoever asks, so a stale route table cannot make
// two processes answer. Every other method of these paths falls through as before (the browser, code and
// research routes beside them stay Node's: they are chat-bound).
//
// METHOD path-pattern in routes.toml's spelling, for noevia's deploy/tools/assemble-release.sh.
const OWNED_ROUTES = Object.freeze(new Set([
  'POST /api/projects/{projectId}/config',
  'GET /api/projects/{projectId}/instruction-skills',
  'PUT /api/projects/{projectId}/instruction-skills',
  'GET /api/projects/{projectId}/instruction-skills/manifests',
  'GET /api/projects/{projectId}/instruction-skills/manifests/{skillId}/content',
  'POST /api/projects/{project}/skills/install',
]));
// routes/projects.cjs's own matchers (one path segment per parameter), as they were.
const PATTERNS = Object.freeze([
  [/^\/api\/projects\/[^/]+\/config$/, ['POST']],
  [/^\/api\/projects\/[^/]+\/instruction-skills$/, ['GET', 'PUT']],
  [/^\/api\/projects\/[^/]+\/instruction-skills\/manifests$/, ['GET']],
  [/^\/api\/projects\/[^/]+\/instruction-skills\/manifests\/[^/]+\/content$/, ['GET']],
  [/^\/api\/projects\/[^/]+\/skills\/install$/, ['POST']],
]);
const ROUTE_REFUSAL = Object.freeze({ error: 'A project\'s configuration and instruction skills are owned by the Rust front.', code: 'RUST_PROJECT_CONFIG_OWNED' });

/** True for the owned method and path (WHATWG pathname, as Node's matchers). */
const owned = (method, pathname) => {
  const m = String(method || 'GET').toUpperCase();
  return PATTERNS.some(([re, methods]) => re.test(String(pathname)) && methods.includes(m));
};

/** Runs before authentication and the workspace load (index.cjs). An unparseable target falls through. */
function refuseOwned(req, res, { parseRequestUrl, json }) {
  if (!['GET', 'POST', 'PUT'].includes(req.method)) return false;
  const url = parseRequestUrl(req, `http://${req.headers.host || 'localhost'}`) || parseRequestUrl(req);
  if (!url || !owned(req.method, url.pathname)) return false;
  json(res, 503, ROUTE_REFUSAL);
  return true;
}

module.exports = { OWNED_ROUTES, ROUTE_REFUSAL, owned, refuseOwned };
