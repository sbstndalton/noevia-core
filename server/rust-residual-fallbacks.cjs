'use strict';
// Residual public answers are native. This boundary refuses a stale front before any account,
// feature, body or engine work. The shared scoped/static fallback remains for Node's other routes.
const RUST_RESIDUAL_FALLBACKS_OWNED = 'rust-residual-fallbacks-v1';
const ROUTE_REFUSAL = Object.freeze({ error: 'Residual route responses are owned by the Rust front.', code: 'RUST_RESIDUAL_FALLBACKS_OWNED' });
// Exact manifest routes remain with their existing owners. All other model paths
// are residuals, except the two substantive handlers behind the single-segment wildcard.
const MODEL_ROUTES = new Set([
  '/api/models/assignments', '/api/models/autotune', '/api/models/autotune/cancel',
  '/api/models/autotune/clear', '/api/models/autotune/resume', '/api/models/autotune/settings',
  '/api/models/autotune/untuned', '/api/models/calibration', '/api/models/calibration/cancel',
  '/api/models/capabilities', '/api/models/delete', '/api/models/downloads', '/api/models/estimate',
  '/api/models/evidence', '/api/models/evidence/import', '/api/models/evidence/recheck',
  '/api/models/hardware', '/api/models/inference-budget', '/api/models/idle-unload',
  '/api/models/installed', '/api/models/load', '/api/models/machines', '/api/models/preset',
  '/api/models/preset/suggest', '/api/models/prune-missing', '/api/models/reranker',
  '/api/models/presets/reload',
]);
function owned(method, p) {
  if (p.startsWith('/api/models/') && !MODEL_ROUTES.has(p)
      && !(['/api/models/pull', '/api/models/unload'].includes(p) && method === 'POST')
      && !(p === '/api/models/mtp-artifact' && method === 'GET')) return true;
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
