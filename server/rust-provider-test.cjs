'use strict';
// sbstndalton/noevia#2190 round 4: the Rust front answers POST /api/providers/test (noevia-rs
// bins/noevia-server provider_test_routes.rs, capability rust-provider-test): the probe of an
// endpoint's /v1/models before a provider is saved. It reads the stored provider rows from disk
// (shared-providers.json, users/<id>/providers.json, as workspace.cjs writes them) for the key it may
// reuse, so Node keeps no state the probe needs. Node answered only POST on this path (its
// PUT|DELETE /api/providers/{id} handler reads `test` as a provider id), so only POST is refused
// here, before authentication: a stale route table cannot make two processes answer.
const PATH = '/api/providers/test';
const ROUTE_REFUSAL = Object.freeze({ error: 'The provider test is owned by the Rust front.', code: 'RUST_PROVIDER_TEST_OWNED' });

function refuseOwned(req, res, { parseRequestUrl, json }) {
  if (req.method !== 'POST') return false;
  const url = parseRequestUrl(req, `http://${req.headers.host || 'localhost'}`) || parseRequestUrl(req);
  if (!url || url.pathname !== PATH) return false;
  json(res, 503, ROUTE_REFUSAL);
  return true;
}

module.exports = { PATH, ROUTE_REFUSAL, refuseOwned };
