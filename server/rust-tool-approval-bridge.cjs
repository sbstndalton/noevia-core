'use strict';
// #2282: narrowly scoped access to the pending chat Promises that still live in Node.
// The Rust public handler owns parsing/decision policy. Facts never leave the trusted
// loopback bridge; resolve atomically rechecks owner, generation, kind and live account.
const crypto = require('node:crypto');
const { trustedFront, sameSecret } = require('./trusted-front.cjs');
const FACTS = '/internal/tool-approvals/facts';
const RESOLVE = '/internal/tool-approvals/resolve';
function createToolApprovalBridge({ secret, pendingApprovals, withActiveUser, json, readJson, log = () => {} }) {
  const generations = new WeakMap();
  const generation = pending => {
    if (!generations.has(pending)) generations.set(pending, crypto.randomBytes(16).toString('hex'));
    return generations.get(pending);
  };
  return async function handle(req, res) {
    const path = String(req.url || '').split('?')[0];
    if (path !== FACTS && path !== RESOLVE) return false;
    if (req.method !== 'POST' || !trustedFront(req, secret)) { json(res, 404, { error: 'Not found' }); return true; }
    let body;
    try { body = await readJson(req); } catch { json(res, 400, { error: 'invalid JSON' }); return true; }
    if (!body || typeof body.user !== 'string' || !body.user || typeof body.id !== 'string' || !body.id) {
      json(res, 400, { error: 'A user and approval id are required.' }); return true;
    }
    try {
      const answer = withActiveUser(body.user, () => {
        const pending = pendingApprovals.get(body.id);
        if (!pending || pending.userId !== body.user) return { found: false };
        const kind = pending.kind === 'route' ? 'route' : 'write';
        if (path === FACTS) return { found: true, kind, generation: generation(pending) };
        // No await between these checks and consuming the pending answer. A stale facts
        // reply can never answer a replacement question, even if an id is reused.
        if (body.kind !== kind || !sameSecret(body.generation, generations.get(pending) || '')) return { found: false };
        const accepted = kind === 'route'
          ? pending.decide(body.decision, { remember: body.remember === true })
          : pending.decide(body.decision);
        return { found: true, accepted: accepted === true };
      });
      json(res, 200, answer || { found: false });
    } catch (e) {
      log(`[tool-approvals] bridge failed: ${e?.code || e?.name || 'error'}`);
      json(res, 503, { error: 'Tool approval state is unavailable.' });
    }
    return true;
  };
}
module.exports = { createToolApprovalBridge, FACTS, RESOLVE };
