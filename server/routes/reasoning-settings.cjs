'use strict';
// /api/reasoning-settings is the Rust front's in full (sbstndalton/noevia#1071 for the PUT, #2384 for the GET;
// noevia-rs crates/server-reasoning-settings). Node answers none of it: a request that reaches this mount bypassed the
// front and is refused before anything is read. The resolution and the request shape are reasoning-effort.cjs, which the
// chat turn still uses; the front asks this process only for `mode` (rust-reasoning-read-facts.cjs).
//
// Returns true when it handled the request. Auth and CSRF run before routes are mounted.

const PASS = Symbol('unhandled');
const PUT_REFUSAL = Object.freeze({ error: 'Reasoning settings are owned by the Rust front.' });
const GET_REFUSAL = Object.freeze({ error: 'The Rust front owns the reasoning settings read.' });

/** @param {object} deps @param {(res, status, body) => any} deps.json */
function createReasoningSettingsRoutes({ json }) {
  async function handle(req, res, { path: p }) {
    if (p !== '/api/reasoning-settings') return PASS;
    if (req.method === 'PUT') return json(res, 503, PUT_REFUSAL);
    if (req.method === 'GET') return json(res, 503, GET_REFUSAL);
    return json(res, 405, { error: 'Method not allowed' });
  }

  return async function reasoningSettingsRoutes(req, res, ctx) {
    return (await handle(req, res, ctx)) !== PASS;
  };
}

module.exports = { createReasoningSettingsRoutes, PUT_REFUSAL, GET_REFUSAL };
