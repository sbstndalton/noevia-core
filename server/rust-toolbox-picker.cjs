'use strict';
// #2281: Rust owns the toolbox picker response and every other method's 405.
const OWNED_ROUTES = Object.freeze(new Set(['ALL /api/toolboxes']));
const ROUTE_REFUSAL = Object.freeze({ error: 'The toolbox picker is owned by the Rust front.', code: 'RUST_TOOLBOX_PICKER_OWNED' });
const owned = (_method, path) => path === '/api/toolboxes';
function refuseOwned(req, res, { parseRequestUrl, json }) {
  const url = parseRequestUrl(req);
  if (!url || !owned(req.method, url.pathname)) return false;
  json(res, 503, ROUTE_REFUSAL); return true;
}
module.exports = { OWNED_ROUTES, ROUTE_REFUSAL, owned, refuseOwned };
