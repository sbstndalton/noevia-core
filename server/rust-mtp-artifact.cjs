'use strict';
// The Rust front answers GET /api/models/mtp-artifact, the MTP/NextN artifact check of a download
// choice (noevia-rs bins/noevia-server model_maint/mtp_artifact.rs, which replays this Core's own
// answers for synthetic sources byte for byte, tests/mtp_artifact.rs and
// tests/fixtures/mtp-artifact-node.json). It lists the variant's files (the source's public file
// metadata, or the other engine's variant list), pins the repository revision and reads the bounded
// GGUF tensor directories; none of that needs this process. A direct Node GET is refused before
// authentication, whoever asks, so a stale route table cannot make two processes answer. Every other
// method of the path stays here (routes/models.cjs).
//
// Kept in its own module so the web supervisor and the release assembly can tell a Core with this
// refusal (`require('./rust-mtp-artifact.cjs')` in index.cjs) from one without it, and pair it with a
// front that lists `rust-mtp-artifact`.
//
// The list is exactly noevia-rs contracts/http/routes.toml's owner = "rust" row, GET only.
const OWNED_PATHS = Object.freeze(['/api/models/mtp-artifact']);
const ROUTE_REFUSAL = Object.freeze({ error: 'The MTP artifact check is owned by the Rust front.', code: 'RUST_MTP_ARTIFACT_OWNED' });

/** True for the exact pathname the front owns (core compared `p === '/api/models/mtp-artifact'`, so no trailing slash). */
const owned = (method, pathname) => method === 'GET' && OWNED_PATHS.includes(pathname);

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

module.exports = { OWNED_PATHS, ROUTE_REFUSAL, owned, refuseOwned };
