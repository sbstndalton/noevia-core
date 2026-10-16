'use strict';
// #778 routing modes: GET/PUT /api/routing-mode and PUT /api/routing-mode/allowed belong to the
// Rust front (sbstndalton/noevia#1071; noevia-rs crates/server-routing-mode), which reads and writes
// the account's routing-mode.json and the 'routing_modes_allowed' settings key. Node no longer
// answers them: a request that reaches Node is a bypass of the front and is refused, whatever the
// method. Chat still reads both (routing-modes.cjs read/allowedModes).

const REFUSAL = Object.freeze({ error: 'Routing settings are owned by the Rust front.' });

function createRoutingModeRoutes({ json }) {
  return async function routingModeRoutes(req, res, { path: p }) {
    if (p !== '/api/routing-mode' && p !== '/api/routing-mode/allowed') return false;
    json(res, 503, REFUSAL);
    return true;
  };
}

module.exports = { createRoutingModeRoutes, REFUSAL };
