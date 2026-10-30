'use strict';
// sbstndalton/noevia#2191 (group rust-project-reads): the Rust front answers a project source's
// stored reads (noevia-rs crates/server-projects sources.rs and originals.rs, served by
// bins/noevia-server project_routes.rs):
//
//   GET /api/projects/{id}/sources/text?name=        one source's text (#1806, #1815)
//   GET /api/projects/{id}/documents/original?name=  a PDF source's stored original
//   GET /api/projects/{id}/uploads/original?name=    an upload's stored bytes (#786)
//
// Each reads projects.json (through the front's own project store, saving getProject's self-heal
// and instruction-skills reconcile under its lock as Node did) and a content-addressed file this
// process writes (source-text.cjs writeText, document-sources.cjs writeOnce, uploads.cjs ingest).
// Those writers stay here and never change a file in place, so a read on the other side is never
// stale and there is no second writer. A direct Node GET for any of the three is refused before
// authentication, whoever asks, so a stale route table cannot make two processes answer.
//
// What stays here, and why (the page reader, GET .../documents/pages, is the front's since round 4:
// rust-project-document-pages.cjs): every write of a source (upload,
// documents, sources/sync, the config route, files DELETE: extraction, OCR, storage and the RAG
// index are this process's in-memory jobs) and every other method of these paths.
//
// The list is exactly noevia-rs contracts/http/routes.toml's rust-project-reads rows, GET only
// (`{*}/original` is `uploads/original` there; any other segment is Node's).
// METHOD path-pattern in routes.toml's spelling: noevia's deploy/tools/assemble-release.sh reads
// this list beside rust-projects.cjs OWNED_ROUTES and refuses a front that owns a project route
// neither lists.
const OWNED_ROUTES = Object.freeze(new Set([
  'GET /api/projects/{id}/sources/text',
  'GET /api/projects/{id}/documents/original',
  'GET /api/projects/{id}/{*}/original',
]));
// routes/projects.cjs's own matchers (one path segment for the id), as they were.
const OWNED_PATTERN = /^\/api\/projects\/[^/]+\/(?:sources\/text|documents\/original|uploads\/original)$/;
const ROUTE_REFUSAL = Object.freeze({ error: 'Project source reads are owned by the Rust front.', code: 'RUST_PROJECT_READS_OWNED' });

/** True for a GET of one of the three pathnames (WHATWG pathname, compared as Node's matchers did). */
const owned = (method, pathname) => method === 'GET' && OWNED_PATTERN.test(String(pathname));

/**
 * Runs before authentication, the maintenance gate and the workspace load (index.cjs
 * handleRequestInner). An unparseable target falls through to the ordinary 400.
 */
function refuseOwned(req, res, { parseRequestUrl, json }) {
  if (req.method !== 'GET') return false;
  const url = parseRequestUrl(req, `http://${req.headers.host || 'localhost'}`) || parseRequestUrl(req);
  if (!url || !owned(req.method, url.pathname)) return false;
  json(res, 503, ROUTE_REFUSAL);
  return true;
}

module.exports = { OWNED_ROUTES, OWNED_PATTERN, ROUTE_REFUSAL, owned, refuseOwned };
