'use strict';
// sbstndalton/noevia#2191 round 8 (group rust-project-source-work): the Rust front runs the project source
// operations itself (noevia-rs crates/server-projects upload.rs, sync.rs, folder_import.rs; served by
// bins/noevia-server project_routes.rs and source_job_routes.rs):
//
//   POST /api/projects/{id}/upload             an organized upload (a file into its type group in the
//                                              project's storage folder) or the older text/PDF upload,
//                                              read by Docling, with the OCR worker's /reduce-pdf for a
//                                              PDF over 25 MB and /extract-docx for a DOCX
//   POST /api/projects/{id}/sources/sync       every attached storage folder re-read (streamed binary
//                                              reads, the storage latch, the OCR budget)
//   POST /api/projects/{id}/folder-import/plan a folder import's plan and its tickets
//
// in the foreground or, with `?background=1`, as a source job (rust-source-jobs.cjs). There is no
// `X-Noevia-Source-Work` worker call any more: Node does not run these operations, so a direct POST is
// refused before authentication, whoever asks and whatever the query, and no second process can write the
// same source. Every other method of the paths falls through as before.
//
// What Node still reads of what the front does: the storage latch (UI_DATA_DIR/storage-latch.db, shared
// with the front: storage-latch.cjs) and the running file operations (users/<id>/source-file-ops.json,
// re-read: rust-source-ops.cjs).
//
// METHOD path-pattern in routes.toml's spelling, for noevia's deploy/tools/assemble-release.sh.
const OWNED_ROUTES = Object.freeze(new Set([
  'POST /api/projects/{id}/upload',
  'POST /api/projects/{id}/sources/sync',
  'POST /api/projects/{id}/folder-import/plan',
]));
// The matchers routes/projects.cjs had.
const PATHS = /^\/api\/projects\/[^/]+\/(upload|sources\/sync|folder-import\/plan)$/;
const ROUTE_REFUSAL = Object.freeze({ error: 'Project source processing is owned by the Rust front.', code: 'RUST_PROJECT_SOURCE_WORK_OWNED' });

/** True for the three POSTs (WHATWG pathname, as Node's matchers; any query). */
const owned = (method, pathname) => method === 'POST' && PATHS.test(String(pathname));

/** Runs before authentication and the workspace load (index.cjs). An unparseable target falls through. */
function refuseOwned(req, res, { parseRequestUrl, json }) {
  if (req.method !== 'POST') return false;
  const url = parseRequestUrl(req, `http://${req.headers.host || 'localhost'}`) || parseRequestUrl(req);
  if (!url || !owned(req.method, url.pathname)) return false;
  json(res, 503, ROUTE_REFUSAL);
  return true;
}

module.exports = { OWNED_ROUTES, ROUTE_REFUSAL, owned, refuseOwned };
