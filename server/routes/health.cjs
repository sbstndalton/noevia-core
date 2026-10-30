'use strict';
// GET /api/health is the Rust front's (sbstndalton/noevia#2190 close-out, rust-health.cjs); the
// retrieval status it reports is published from here (rust-health.cjs, published-snapshot.cjs).
//
// GET /api/ready (#297) is unauthenticated: it answers only whether the process has
// finished startup wiring, as {ready, version}. No tenant data, no upstream detail — a caller
// needs this before a session exists to check it with.

/**
 * GET /api/ready, mounted unauthenticated before the session gate (like the sign-in routes).
 * @param {object} deps
 * @param {(res, status, body) => any} deps.json
 * @param {() => boolean} deps.isReady   true once startup wiring has finished
 * @param {string} deps.version          reported as-is; no upstream or tenant detail
 */
function createReadyRoutes({ json, isReady, version }) {
  return async function readyRoutes(req, res, { path: p }) {
    if (p === '/api/ready' && req.method === 'GET') {
      json(res, 200, { ready: !!isReady(), version: String(version || '') });
      return true;
    }
    return false;
  };
}

module.exports = { createReadyRoutes };
