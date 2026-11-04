'use strict';
// sbstndalton/noevia#2384: what the Rust front's reasoning-settings read cannot know, because only this process has it:
// how the provider will be asked (reasoning-effort.cjs modeFor: the provider row's capabilities, the local engine and
// machine facts, and the set of providers that rejected the parameter during a chat turn).
// Reached only by the front's own loopback calls (trusted-front.cjs); anything else gets the 404 of an unknown path.
//
//   POST /internal/reasoning-read/facts {user, provider, model, effort}
//     -> {mode: 'off' | 'real' | 'hint'}   as the route answered `mode` for that user's workspace
//
// `provider` and `model` are the project's own values (null when it has none); the default provider and the empty model
// are applied here, exactly where the route applied them.
const { trustedFront } = require('./trusted-front.cjs');

const PATH = '/internal/reasoning-read/facts';
const MODES = new Set(['off', 'real', 'hint']);

function createReasoningReadFacts({ secret, json, readJson, modeFor, log = (m) => console.warn(m) }) {
  return async function handle(req, res) {
    if (req.url !== PATH) return false;
    if (req.method !== 'POST' || !trustedFront(req, secret)) { json(res, 404, { error: 'Not found' }); return true; }
    let body;
    try { body = await readJson(req); } catch { json(res, 400, { error: 'invalid JSON' }); return true; }
    const { user, provider, model, effort } = body || {};
    if (typeof user !== 'string' || !user || !['default', 'low', 'high'].includes(effort)) { json(res, 400, { error: 'A user and an effort are required.' }); return true; }
    try {
      const mode = await modeFor({ user, provider: provider || null, model: model || '', effort });
      if (!MODES.has(mode)) throw new Error('unknown mode');
      json(res, 200, { mode });
    } catch (e) {
      log(`[reasoning] mode facts failed: ${e?.code || e?.name || 'error'}`);
      json(res, 503, { error: 'Reasoning facts are unavailable.' });
    }
    return true;
  };
}

module.exports = { createReasoningReadFacts, PATH };
