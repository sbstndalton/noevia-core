'use strict';
// /api/import/conversations: the POST (the import itself) is the Rust front's since #2191 round 4
// (noevia-rs crates/server-projects import.rs; rust-conversation-import.cjs refuses it before
// authentication). Every other method keeps the 405 it always had. Auth/CSRF run before routes.

function createImportRoutes({ json }) {
  return async function importRoutes(req, res, { path, authn }) {
    if (path !== '/api/import/conversations') return false;
    if (!authn) return json(res, 401, { error: 'Sign in first' }), true;
    return json(res, 405, { error: 'method not allowed' }), true;
  };
}

module.exports = { createImportRoutes };
