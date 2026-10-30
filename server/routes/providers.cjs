'use strict';
// The provider registry's HTTP surface is the Rust front's (noevia-rs bins/noevia-server
// provider_routes.rs, sbstndalton/noevia#2190 round 6; rust-providers.cjs refuses its routes before
// authentication):
//   GET    /api/providers        list, with keys masked
//   POST   /api/providers        connect one (shared rows are admin-only)
//   PUT    /api/providers/:id    edit one in place (#535)
//   DELETE /api/providers/:id    remove one; projects on it fall back to the default
//   DELETE /api/providers/chatgpt   disconnect Sign in with ChatGPT (tokens, row and fallbacks)
//   POST   /api/providers/test   the probe (round 4, rust-provider-test.cjs)
//   GET    /api/providers/:id/models[?refresh=1]  (round 5, rust-provider-models.cjs)
//   GET    /api/providers/chatgpt, POST .../chatgpt/device[/poll|/cancel], GET .../chatgpt/models
//                                 Sign in with ChatGPT's status, device sign-in and catalogue
//                                 (M6 and round 5, the front's token broker)
// The front is the only writer of users/<id>/providers.json and shared-providers.json; this
// process re-reads the private rows by the file's change signal (workspace.cjs) and never writes
// them. This mount remains for what is still Node's on these paths, and as the last refusal of a
// request that got past the early one (a stale route table), so two processes never answer:
//   the other methods on /api/providers/chatgpt and /chatgpt/*: 404 while Sign in with ChatGPT is
//   turned off (features.chatgptOAuth), 401 signed out, else 405.
//
// Returns true when it handled the request. Auth and CSRF run before routes are mounted.

const PASS = Symbol('unhandled');

/**
 * @param {object} deps
 * @param {(res, status, body) => any} deps.json
 * @param {object|null} [deps.chatgptOAuth]   chatgpt-oauth.cjs; null leaves Sign in with ChatGPT out entirely
 * @param {() => boolean} [deps.chatgptEnabled]   features.enabled('chatgptOAuth')
 */
function createProviderRoutes({ json, chatgptOAuth = null, chatgptEnabled = () => false }) {
  const { RUST_CHATGPT_STATUS_REFUSAL } = require('../features.cjs');
  const brokerRoutes = require('../rust-chatgpt-oauth.cjs');
  const registry = require('../rust-providers.cjs');
  const chatgptOn = () => !!chatgptOAuth && chatgptEnabled();

  async function handleChatGpt(req, res, p, authn) {
    // The status GET is the Rust front's (sbstndalton/noevia#1071); the device sign-in and the model
    // list are the broker's; the disconnect is the registry's (round 6). One that reaches this mount
    // is a bypass, refused before any read.
    if (p === '/api/providers/chatgpt' && req.method === 'GET') return json(res, 503, RUST_CHATGPT_STATUS_REFUSAL);
    if (brokerRoutes.owned(req.method, p)) return json(res, 503, brokerRoutes.ROUTE_REFUSAL);
    if (registry.owned(req.method, p)) return json(res, 503, registry.ROUTE_REFUSAL);
    if (!chatgptOn()) return json(res, 404, { error: 'Sign in with ChatGPT is turned off on this server.' });
    if (!authn?.user?.id) return json(res, 401, { error: 'Sign in to noevia first.' });
    return json(res, 405, { error: 'method not allowed' });
  }

  async function handle(req, res, { path: p, authn }) {
    // A stored provider's model list is the Rust front's (rust-provider-models.cjs, refused before
    // authentication); one that reaches this mount is a bypass, refused before any read.
    if (require('../rust-provider-models.cjs').owned(p)) return json(res, 503, require('../rust-provider-models.cjs').ROUTE_REFUSAL);
    if (p === '/api/providers/chatgpt' || p.startsWith('/api/providers/chatgpt/')) return handleChatGpt(req, res, p, authn);
    // The registry (list, connect, edit, remove) is the Rust front's, as is the probe: a bypass.
    if (registry.owned(req.method, p)) return json(res, 503, registry.ROUTE_REFUSAL);
    if (p === '/api/providers/test' && req.method === 'POST') return json(res, 503, require('../rust-provider-test.cjs').ROUTE_REFUSAL);
    return PASS;
  }

  return async function providerRoutes(req, res, ctx) {
    return (await handle(req, res, ctx)) !== PASS;
  };
}

module.exports = { createProviderRoutes };
