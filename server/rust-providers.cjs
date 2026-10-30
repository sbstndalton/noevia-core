'use strict';
// sbstndalton/noevia#2190 round 6: the Rust front owns the provider registry (noevia-rs
// bins/noevia-server provider_routes.rs, capability rust-providers): GET and POST /api/providers,
// PUT and DELETE /api/providers/<id>, and DELETE /api/providers/chatgpt (the ChatGPT disconnect:
// the broker's tokens, the provider row and the projects' fallbacks). The front is the only writer
// of users/<id>/providers.json and shared-providers.json, including the ChatGPT row its token
// broker writes when a sign-in is saved; this process re-reads the private rows by the file's change
// signal on every use (workspace.cjs, shared-reread.cjs), keeps no copy, and saves only its
// seal-on-load migration of a plaintext key, through the project store (project-store-client.cjs). A secrets
// rotation does not rewrite the files either: it asks the front to re-seal them first
// (rust-providers-reseal.cjs, capability rust-providers-reseal).
// Node answered exactly these methods on these paths, so only they are refused here, before
// authentication: a stale route table cannot make two processes write the same file. Everything else
// on the paths (a PUT on /api/providers/chatgpt, its 404 or 405) stays Node's.
const SEGMENT = /^\/api\/providers\/([^/]+)$/;
const ROUTE_REFUSAL = Object.freeze({ error: 'The provider registry is owned by the Rust front.', code: 'RUST_PROVIDERS_OWNED' });

/** Whether `method` on the exact `pathname` is the front's. */
function owned(method, pathname) {
  const p = String(pathname || '');
  if (p === '/api/providers') return method === 'GET' || method === 'POST';
  const m = SEGMENT.exec(p);
  if (!m) return false;
  if (method === 'DELETE') return true;
  return method === 'PUT' && m[1] !== 'chatgpt';
}

function refuseOwned(req, res, { parseRequestUrl, json }) {
  const url = parseRequestUrl(req, `http://${req.headers.host || 'localhost'}`) || parseRequestUrl(req);
  if (!url || !owned(req.method, url.pathname)) return false;
  json(res, 503, ROUTE_REFUSAL);
  return true;
}

module.exports = { ROUTE_REFUSAL, owned, refuseOwned };
