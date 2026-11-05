'use strict';
// Retention GET and PUT are owned by the native front. Other verbs retain Core's response.
const REFUSAL = Object.freeze({ error: 'Retention settings are owned by the Rust front.' });
function createAccountRoutes({ json }) {
  return async function accountRoutes(req, res, { path, authn }) {
    if (path !== '/api/account/retention') return false;
    if (!authn) return json(res, 401, { error: 'Sign in first' }), true;
    if (['GET', 'PUT'].includes(req.method)) return json(res, 503, REFUSAL), true;
    return json(res, 405, { error: 'method not allowed' }), true;
  };
}
module.exports = { createAccountRoutes, REFUSAL };
