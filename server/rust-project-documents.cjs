'use strict';
// sbstndalton/noevia#2191 round 5 (group rust-project-documents): the Rust front answers a project
// document's upload on its own extraction pipeline (noevia-rs crates/server-projects
// project_documents.rs, extract.rs, extract_queue.rs; served by bins/noevia-server project_routes.rs):
//
//   POST /api/projects/{id}/documents   the document read by Docling (and the OCR worker for the
//                                       per-page retry), stored in this process's file formats
//                                       (project-documents/<sha256 id>/<byteHash>.pdf, <version>.json),
//                                       the source listed, an `index` job queued in the index outbox
//
// Docling is THE extraction engine for new project documents (the 2026-10-30 decision): the front has
// no pdf.js reader. When Docling is unavailable, busy or not configured, the document is stored as
// this process stored an unreachable worker's result (state `failed`, the worker's error, the record
// retryable) with `document.extraction: "queued"`, and its job waits in the front's durable queue
// (users/<id>/extraction-jobs.db) until Docling reads it. Already stored documents are never
// re-extracted.
//
// A direct Node POST is refused before authentication, whoever asks, so a stale route table cannot
// make two processes write the same source. Every other method of the path falls through as before.
// Uploads (`/upload`), the folder sync and folder imports still extract here.
//
// METHOD path-pattern in routes.toml's spelling, for noevia's deploy/tools/assemble-release.sh.
const OWNED_ROUTES = Object.freeze(new Set([
  'POST /api/projects/{id}/documents',
]));
// routes/projects.cjs's own matcher, as it was.
const DOCUMENTS = /^\/api\/projects\/[^/]+\/documents$/;
const ROUTE_REFUSAL = Object.freeze({ error: 'Uploading a project document is owned by the Rust front.', code: 'RUST_PROJECT_DOCUMENTS_OWNED' });

/** True for POST /api/projects/{id}/documents (WHATWG pathname, as Node's matcher; any query). */
const owned = (method, pathname) => method === 'POST' && DOCUMENTS.test(String(pathname));

/** Runs before authentication and the workspace load (index.cjs). An unparseable target falls through. */
function refuseOwned(req, res, { parseRequestUrl, json }) {
  if (req.method !== 'POST') return false;
  const url = parseRequestUrl(req, `http://${req.headers.host || 'localhost'}`) || parseRequestUrl(req);
  if (!url || !owned(req.method, url.pathname)) return false;
  json(res, 503, ROUTE_REFUSAL);
  return true;
}

module.exports = { OWNED_ROUTES, ROUTE_REFUSAL, owned, refuseOwned };
