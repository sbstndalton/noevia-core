'use strict';
// GET /api/reasoning-settings is the Rust front's (sbstndalton/noevia#2384): the project lookup, the stored default and the
// effort resolution are native. The provider-dependent `mode` is this process's alone (the live rejection set and the
// machine and engine facts of reasoning-effort.cjs), reached through rust-reasoning-read-facts.cjs.
const OWNED_ROUTES = Object.freeze(new Set(['GET /api/reasoning-settings']));
const REFUSAL = Object.freeze({ error: 'The Rust front owns the reasoning settings read.' });
function refuseOwned(req, res, { parseRequestUrl, json }) {
  if (req.method !== 'GET' || parseRequestUrl(req).pathname !== '/api/reasoning-settings') return false;
  json(res, 503, REFUSAL);
  return true;
}
module.exports = { OWNED_ROUTES, REFUSAL, refuseOwned };
