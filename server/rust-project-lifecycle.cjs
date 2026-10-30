'use strict';
// sbstndalton/noevia#2191 round 2 (group rust-project-lifecycle): the Rust front creates and
// deletes projects (noevia-rs crates/server-projects lifecycle.rs, served by bins/noevia-server
// project_routes.rs):
//
//   POST   /api/projects               create (folder reservation #589, create-time files #659)
//   DELETE /api/projects/{projectId}   delete (uploads, documents, images, RAG index, chats #554,
//                                      their attachments projects #788, the storage sweep D8)
//
// Both write projects.json under its lock (the front is its only writer; this process re-reads it
// at each request start, rust-projects.cjs). What a create or delete leaves to do here, because the
// engine lives here, is queued in the user's index outbox (users/<id>/index-outbox.db): the RAG index
// of create-time files (sqlite-vec is loaded by rag.cjs only); since round 3 the empty storage folder
// sweep and #687's storage step are the front's (rust-project-storage.cjs). rust-index-outbox.cjs
// drains the index jobs; a delete's tombstone stops an index
// run of that project that is still in flight here (rag.cjs), so it never recreates the index.
// The front reads the toolbox ids a project may select from project-catalogue.cjs's published file:
// MCP discovery stays here.
//
// A direct Node request for either route is refused before authentication, whoever asks, so a stale
// route table cannot make two processes answer. Every other method of these paths falls through as
// before. The conversation import creates projects through the front's create too since round 4
// (rust-conversation-import.cjs); the free chat attachments and Diary context paths stay here.
//
// METHOD path-pattern in routes.toml's spelling: noevia's deploy/tools/assemble-release.sh reads this
// list beside rust-projects.cjs OWNED_ROUTES and refuses a front that owns a project route neither lists.
const OWNED_ROUTES = Object.freeze(new Set([
  'POST /api/projects',
  'DELETE /api/projects/{projectId}',
]));
// routes/projects.cjs's own matchers (one path segment for the id), as they were.
const ONE_PROJECT = /^\/api\/projects\/[^/]+$/;
const ROUTE_REFUSAL = Object.freeze({ error: 'Project create and delete are owned by the Rust front.', code: 'RUST_PROJECT_LIFECYCLE_OWNED' });

/** True for POST /api/projects and DELETE /api/projects/{id} (WHATWG pathname, as Node's matchers). */
const owned = (method, pathname) => (method === 'POST' && pathname === '/api/projects')
  || (method === 'DELETE' && ONE_PROJECT.test(String(pathname)));

/** Runs before authentication and the workspace load (index.cjs). An unparseable target falls through. */
function refuseOwned(req, res, { parseRequestUrl, json }) {
  if (req.method !== 'POST' && req.method !== 'DELETE') return false;
  const url = parseRequestUrl(req, `http://${req.headers.host || 'localhost'}`) || parseRequestUrl(req);
  if (!url || !owned(req.method, url.pathname)) return false;
  json(res, 503, ROUTE_REFUSAL);
  return true;
}

module.exports = { OWNED_ROUTES, ROUTE_REFUSAL, owned, refuseOwned };
