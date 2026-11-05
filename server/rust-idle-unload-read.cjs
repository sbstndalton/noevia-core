'use strict';
const OWNED_ROUTES = Object.freeze(new Set(['GET /api/models/idle-unload', 'PUT /api/models/idle-unload', 'POST /api/models/prune-missing']));
function refuseOwned(req, res, { parseRequestUrl, json }) {
  const path = parseRequestUrl(req)?.pathname;
  if (!OWNED_ROUTES.has(`${req.method} ${path}`)) return false;
  json(res, 503, { error: 'Model writes and the idle unload read are owned by the Rust front.' });
  return true;
}
module.exports = { OWNED_ROUTES, refuseOwned };
