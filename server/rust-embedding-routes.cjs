'use strict';
// The paired Rust front owns all methods, migration and managed-service effects.
const FRONT_FEATURE = 'noevia-embedding-routes-authority/1';
const EMBEDDING_ROUTES_MARKER = 'noevia-embedding-routes-client/1';
function refuseOwned(req, res, { parseRequestUrl, json }) {
  if (parseRequestUrl(req)?.pathname !== '/api/embedding') return false;
  json(res, 503, { error: 'Embedding settings are owned by the Rust front.', code: 'RUST_EMBEDDING_ROUTES_OWNED' });
  return true;
}
module.exports = { FRONT_FEATURE, EMBEDDING_ROUTES_MARKER, refuseOwned };
