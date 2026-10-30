'use strict';
// sbstndalton/noevia#2191 round 4 (group rust-project-document-pages): the Rust front answers a
// stored document's page reader (noevia-rs crates/server-projects document_pages.rs, served by
// bins/noevia-server project_routes.rs):
//
//   GET /api/projects/{id}/documents/pages   readPages over project-documents/<sha256 id>/<version>.json,
//                                            with the document's notice, answer for answer
//
// The stored results are written once per version by this process's extraction (document-sources.cjs
// writeOnce: fsynced temp, atomic rename), so the front never reads a torn one. A direct Node GET is
// refused before authentication, whoever asks, so a stale route table cannot make two processes
// answer. Every other method of the path falls through as before. The chat tool read_document_pages
// (toolboxes.cjs) still reads pages in this process through document-sources.cjs readPages.
//
// METHOD path-pattern in routes.toml's spelling, for noevia's deploy/tools/assemble-release.sh.
const OWNED_ROUTES = Object.freeze(new Set([
  'GET /api/projects/{id}/documents/pages',
]));
// routes/projects.cjs's own matcher, as it was.
const PAGES = /^\/api\/projects\/[^/]+\/documents\/pages$/;
const ROUTE_REFUSAL = Object.freeze({ error: 'Reading a document\'s pages is owned by the Rust front.', code: 'RUST_PROJECT_DOCUMENT_PAGES_OWNED' });

/** True for GET /api/projects/{id}/documents/pages (WHATWG pathname, as Node's matcher). */
const owned = (method, pathname) => method === 'GET' && PAGES.test(String(pathname));

/** Runs before authentication and the workspace load (index.cjs). An unparseable target falls through. */
function refuseOwned(req, res, { parseRequestUrl, json }) {
  if (req.method !== 'GET') return false;
  const url = parseRequestUrl(req, `http://${req.headers.host || 'localhost'}`) || parseRequestUrl(req);
  if (!url || !owned(req.method, url.pathname)) return false;
  json(res, 503, ROUTE_REFUSAL);
  return true;
}

module.exports = { OWNED_ROUTES, ROUTE_REFUSAL, owned, refuseOwned };
