'use strict';
// GET /api/export/conversations belongs to the Rust front (sbstndalton/noevia#1071; noevia-rs
// crates/server-export), which builds the zip from the user's files on disk and audits it. A GET
// that reaches Node is a bypass of the front: refused, nothing read, built or audited. Every other
// method keeps Node's answers (401 signed out, 405).
//
// Returns true when it handled the request. Auth runs before routes are mounted.
const REFUSAL = Object.freeze({ error: 'Conversation export is owned by the Rust front.' });

function createExportRoutes({ json }) {
  return async function exportRoutes(req, res, { path, authn }) {
    if (path !== '/api/export/conversations') return false;
    if (!authn) return json(res, 401, { error: 'Sign in first' }), true;
    if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' }), true;
    return json(res, 503, REFUSAL), true;
  };
}

module.exports = { createExportRoutes, REFUSAL };
