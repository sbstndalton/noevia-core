'use strict';
const { trustedFront } = require('./trusted-front.cjs');
const PATH = '/internal/preset-read/facts';
const MAX_BYTES = 8 * 1024 * 1024;

function readFault(error) {
  if (error?.status === 409 && error.message === 'Preset path must be a regular file') return 'nonregular';
  if (error?.status === 409 && error.message === 'Duplicate preset sections require operator repair') return 'duplicate';
  if (error?.status === 413 && error.message === 'Preset file exceeds the editor limit') return 'oversized';
  return 'read-failed';
}

function createPresetReadBridge({ secret, json, readJson, manager }) {
  return async function handle(req, res) {
    if (String(req.url || '').split('?')[0] !== PATH) return false;
    if (req.method !== 'POST' || !trustedFront(req, secret) ||
        Object.hasOwn(req.headers, 'x-forwarded-for') || Object.hasOwn(req.headers, 'x-noevia-client-ip')) {
      json(res, 404, { error: 'Not found' });
      return true;
    }
    let ask;
    try { ask = await readJson(req, 1024 * 1024); }
    catch { json(res, 400, { error: 'invalid JSON' }); return true; }
    if (!ask || typeof ask !== 'object' || Array.isArray(ask) ||
        Object.keys(ask).length !== 1 || typeof ask.model !== 'string' || ask.model.length > 65536) {
      json(res, 400, { error: 'Invalid preset facts request.' });
      return true;
    }
    let answer;
    try {
      const live = manager();
      if (typeof live?.presetFacts !== 'function') {
        answer = { kind: 'unavailable' };
      } else {
        const facts = live.presetFacts(ask.model);
        if (facts === null) {
          answer = { kind: 'unconfigured' };
        } else {
          const { revision, exists, options, defaults, fields } = facts;
          answer = { kind: 'preset', revision, exists, options, defaults, fields };
          if (Buffer.byteLength(JSON.stringify(answer)) > MAX_BYTES) answer = { kind: 'read-failed' };
        }
      }
    } catch (error) {
      answer = { kind: readFault(error) };
    }
    json(res, 200, answer);
    return true;
  };
}
module.exports = { createPresetReadBridge, PATH };
