'use strict';
const OWNED_ROUTES = Object.freeze(new Set(['GET /api/models/idle-unload']));
function refuseOwned(req, res, { parseRequestUrl, json }) {
  if (req.method !== 'GET' || parseRequestUrl(req).pathname !== '/api/models/idle-unload') return false;
  json(res, 503, { error: 'The Rust front owns the idle unload setting read.' });
  return true;
}
module.exports = { OWNED_ROUTES, refuseOwned };
