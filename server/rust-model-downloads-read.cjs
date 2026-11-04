'use strict';
const OWNED_ROUTES = Object.freeze(new Set(['GET /api/models/downloads']));
function refuseOwned(req, res, { parseRequestUrl, json }) {
  if (!OWNED_ROUTES.has(req.method + ' ' + parseRequestUrl(req)?.pathname)) return false;
  json(res, 503, { error: 'The Rust front owns model download reads.' });
  return true;
}
module.exports = { OWNED_ROUTES, refuseOwned };
