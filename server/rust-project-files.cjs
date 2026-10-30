'use strict';
// sbstndalton/noevia#2191 round 3 (group rust-project-files): the Rust front deletes a project's
// source file from the user's storage (noevia-rs crates/server-projects files.rs, served by
// bins/noevia-server project_routes.rs):
//
//   DELETE /api/projects/{id}/files   ownsFile, storage-client deleteFile (through the front's own
//                                     write client), the list, the prune (#1914 order)
//
// The file's RAG rows are this process's (sqlite-vec is loaded by rag.cjs only): the front queues an
// `unindex` job in the user's index outbox, which rust-index-outbox.cjs runs here (rag.cjs
// deleteProjectFile) unless a file of that name is listed again by then (#1919).
//
// A direct Node request is refused before authentication, whoever asks, so a stale route table
// cannot make two processes answer. Every other method of the path falls through as before.
//
// METHOD path-pattern in routes.toml's spelling, for noevia's deploy/tools/assemble-release.sh.
const OWNED_ROUTES = Object.freeze(new Set([
  'DELETE /api/projects/{id}/files',
]));
// routes/projects.cjs's own matcher, as it was.
const FILES = /^\/api\/projects\/[^/]+\/files$/;
const ROUTE_REFUSAL = Object.freeze({ error: 'Deleting a project source file is owned by the Rust front.', code: 'RUST_PROJECT_FILES_OWNED' });

/** True for DELETE /api/projects/{id}/files (WHATWG pathname, as Node's matcher). */
const owned = (method, pathname) => method === 'DELETE' && FILES.test(String(pathname));

/** Runs before authentication and the workspace load (index.cjs). An unparseable target falls through. */
function refuseOwned(req, res, { parseRequestUrl, json }) {
  if (req.method !== 'DELETE') return false;
  const url = parseRequestUrl(req, `http://${req.headers.host || 'localhost'}`) || parseRequestUrl(req);
  if (!url || !owned(req.method, url.pathname)) return false;
  json(res, 503, ROUTE_REFUSAL);
  return true;
}

module.exports = { OWNED_ROUTES, ROUTE_REFUSAL, owned, refuseOwned };
