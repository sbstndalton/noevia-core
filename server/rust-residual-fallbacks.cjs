'use strict';
// Residual public answers are native. This boundary refuses a stale front before any account,
// feature, body or engine work. The shared scoped/static fallback remains for Node's other routes.
const RUST_RESIDUAL_FALLBACKS_OWNED = 'rust-residual-fallbacks-v1';
const ROUTE_REFUSAL = Object.freeze({ error: 'Residual route responses are owned by the Rust front.', code: 'RUST_RESIDUAL_FALLBACKS_OWNED' });
function owned(method, p) {
  if (p === '/api/providers/chatgpt' || p.startsWith('/api/providers/chatgpt/')) return true;
  if (['/api/models/assignments', '/api/models/installed', '/api/models/downloads', '/api/models/hardware', '/api/models/estimate', '/api/models/preset/suggest'].includes(p)) return method !== 'GET';
  if (p === '/api/models/prune-missing') return method !== 'POST';
  return p === '/api/models/reranker' && !['GET', 'PUT', 'DELETE'].includes(method);
}
function refuseOwned(req, res, { parseRequestUrl, json }) {
  const p = parseRequestUrl(req)?.pathname;
  if (!p || !owned(req.method, p)) return false;
  json(res, 503, ROUTE_REFUSAL);
  return true;
}
module.exports = { RUST_RESIDUAL_FALLBACKS_OWNED, ROUTE_REFUSAL, owned, refuseOwned };
