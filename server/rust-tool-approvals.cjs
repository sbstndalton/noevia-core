'use strict';
// #2282: the Rust front owns the public decision route; Node keeps only the in-memory
// pending Promise resolution in rust-tool-approval-bridge.cjs until chat itself moves.
const OWNED_ROUTES = Object.freeze(new Set(['POST /api/tool-approvals/{approvalId}']));
const ROUTE_REFUSAL = Object.freeze({ error: 'Tool approval decisions are owned by the Rust front.', code: 'RUST_TOOL_APPROVALS_OWNED' });
const owned = (method, pathname) => method === 'POST' && /^\/api\/tool-approvals\/[^/]+$/.test(String(pathname));
function refuseOwned(req, res, { parseRequestUrl, json }) {
  const url = parseRequestUrl(req);
  if (!url || !owned(req.method, url.pathname)) return false;
  json(res, 503, ROUTE_REFUSAL);
  return true;
}
module.exports = { OWNED_ROUTES, ROUTE_REFUSAL, owned, refuseOwned };
