'use strict';
// R3-0: the Rust front is the one writer of the model state this process used to clear itself (the
// last-loaded default and the evidence identity cache). After it clears its own copy it calls this
// internal route so Node's in-memory copies agree. It accepts one name and nothing else.
const { trustedFront } = require('./trusted-front.cjs');
const PATH = '/internal/model-state/forget';
function createBridge({ secret, json, readJson, service }) {
  return async (req, res) => {
    if (String(req.url || '').split('?')[0] !== PATH) return false;
    if (req.method !== 'POST' || !trustedFront(req, secret) || Object.hasOwn(req.headers, 'x-forwarded-for') || Object.hasOwn(req.headers, 'x-noevia-client-ip')) { json(res, 404, { error: 'Not found' }); return true; }
    let ask;
    try { ask = await readJson(req, 4096); } catch { json(res, 400, { error: 'invalid JSON' }); return true; }
    if (!ask || typeof ask !== 'object' || Array.isArray(ask) || Object.keys(ask).length !== 1 || typeof ask.name !== 'string' || !ask.name) { json(res, 400, { error: 'Invalid model-state operation.' }); return true; }
    try { service.forgetModelStateLocal(ask.name); json(res, 200, { ok: true }); } catch { json(res, 503, { error: 'Model state is unavailable.' }); }
    return true;
  };
}
module.exports = { PATH, createBridge };
