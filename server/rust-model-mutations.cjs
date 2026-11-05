'use strict';
const OWNED_ROUTES = Object.freeze(new Set(['POST /api/models/pull', 'POST /api/models/delete']));
const MODEL_MUTATIONS_CLIENT_MARKER = 'noevia-model-mutations-client/1';
function refuseOwned(req, res, { parseRequestUrl, json }) {
  if (!OWNED_ROUTES.has(req.method + ' ' + parseRequestUrl(req)?.pathname)) return false;
  json(res, 503, { error: 'The Rust front owns model pull and delete.' });
  return true;
}
module.exports = { OWNED_ROUTES, MODEL_MUTATIONS_CLIENT_MARKER, refuseOwned };
