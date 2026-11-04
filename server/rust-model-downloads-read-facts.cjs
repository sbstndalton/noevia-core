'use strict';
const { trustedFront } = require('./trusted-front.cjs');
const PATH = '/internal/model-downloads-read/facts';
const FIELDS = ['id', 'job_id', 'model_name', 'model', 'checkpoint', 'percent', 'progress', 'status', 'state'];

function row(value) {
  // routes/models.cjs read every field of a null row and threw; Rust keeps that as its fault.
  if (value == null) return null;
  const fields = {};
  const infinite = [];
  for (const key of FIELDS) {
    const field = value[key];
    // JSON.parse accepts overflowing numbers; JSON.stringify would silently turn
    // them into null before Rust can apply the original truthiness/type rules.
    if (field === Infinity || field === -Infinity) infinite.push(key);
    else if (field !== undefined) fields[key] = field;
  }
  return infinite.length ? { fields, infinite } : { fields };
}

// The listing routes/models.cjs mapped, chosen exactly as it chose it. Only the chosen array
// is sent: an unchosen alternative is never expanded, and nothing caps what core never capped.
function facts(body) {
  const selected = Array.isArray(body) ? body : body?.jobs || body?.downloads || [];
  // A chosen value that is not an array had no map(): the old route threw.
  if (!Array.isArray(selected)) return { kind: 'fault' };
  return { kind: 'listing', rows: selected.map(row) };
}

function createModelDownloadsFacts({ secret, json, manager }) {
  return async function handle(req, res) {
    if (req.url !== PATH) return false;
    if (req.method !== 'POST' || !trustedFront(req, secret) ||
        Object.hasOwn(req.headers, 'x-forwarded-for') || Object.hasOwn(req.headers, 'x-noevia-client-ip')) {
      json(res, 404, { error: 'Not found' });
      return true;
    }
    let answer;
    try {
      const live = manager();
      if (!live.enabled) {
        answer = { kind: 'disabled' };
      } else {
        const result = await live.downloads();
        answer = result.ok ? facts(result.body) : { kind: 'failed' };
      }
    } catch {
      answer = { kind: 'fault' };
    }
    json(res, 200, answer);
    return true;
  };
}
module.exports = { createModelDownloadsFacts, PATH };
