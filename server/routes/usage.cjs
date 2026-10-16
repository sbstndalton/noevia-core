'use strict';
// /api/usage and /api/usage/aggregate belong to the Rust front (sbstndalton/noevia#1071; noevia-rs
// crates/server-usage). Node no longer answers them: a request that reaches it is a bypass of the
// front and is refused, whatever the method. Recording stays Node's (usage.cjs).
//
// Returns true when it handled the request.
const REFUSAL = Object.freeze({ error: 'Usage reporting is owned by the Rust front.' });

function createUsageRoutes({ json }) {
  return async function usageRoutes(req, res, { path }) {
    if (path !== '/api/usage' && path !== '/api/usage/aggregate') return false;
    return json(res, 503, REFUSAL), true;
  };
}

module.exports = { createUsageRoutes, REFUSAL };
