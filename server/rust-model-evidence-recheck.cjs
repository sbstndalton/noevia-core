'use strict';
// #2286: Rust owns the public probe and evidence write. Node retains only the existing
// engine-admission lease, whose live budget/quarantine/maintenance state is shared with chat.
const OWNED_ROUTES = Object.freeze(new Set(['POST /api/models/evidence/recheck']));
const ROUTE_REFUSAL = Object.freeze({ error: 'Model evidence recheck is owned by the Rust front.', code: 'RUST_MODEL_EVIDENCE_RECHECK_OWNED' });
const owned = (method, path) => method === 'POST' && path === '/api/models/evidence/recheck';
function refuseOwned(req, res, { parseRequestUrl, json }) {
  const url = parseRequestUrl(req);
  if (!url || !owned(req.method, url.pathname)) return false;
  json(res, 503, ROUTE_REFUSAL); return true;
}
module.exports = { OWNED_ROUTES, ROUTE_REFUSAL, owned, refuseOwned };
