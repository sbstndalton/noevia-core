'use strict';
const OWNED_ROUTES = Object.freeze(new Set(['GET /api/models/assignments']));
function refuseOwned(req, res, { parseRequestUrl, json }) {
  if (req.method !== 'GET' || parseRequestUrl(req).pathname !== '/api/models/assignments') return false;
  json(res, 503, { error: 'The Rust front owns model assignments reads.' });
  return true;
}
module.exports = { OWNED_ROUTES, refuseOwned };
