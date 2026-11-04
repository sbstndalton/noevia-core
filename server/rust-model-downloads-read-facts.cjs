'use strict';
const { trustedFront } = require('./trusted-front.cjs');
const PATH = '/internal/model-downloads-read/facts';
const MAX_BYTES = 16 * 1024 * 1024;
const FIELDS = ['id', 'job_id', 'model_name', 'model', 'checkpoint', 'percent', 'progress', 'status', 'state'];

function listing(value) {
  // Keep the truthiness of malformed alternatives without sending their contents.
  if (!Array.isArray(value)) return Boolean(value);
  return value.map(row => {
    if (row == null) return null;
    const fields = {};
    const infinite = [];
    for (const key of FIELDS) {
      const value = row[key];
      // JSON.parse accepts overflowing numbers; JSON.stringify would silently turn
      // them into null before Rust can apply the original truthiness/type rules.
      if (value === Infinity || value === -Infinity) infinite.push(key);
      else if (value !== undefined) fields[key] = value;
    }
    return infinite.length ? { fields, infinite } : { fields };
  });
}

function createModelDownloadsFacts({ secret, json, manager }) {
  return async function handle(req, res) {
    if (req.url !== PATH) return false;
    if (req.method !== 'POST' || !trustedFront(req, secret) ||
        Object.hasOwn(req.headers, 'x-forwarded-for') || Object.hasOwn(req.headers, 'x-noevia-client-ip')) {
      json(res, 404, { error: 'Not found' });
      return true;
    }
    let facts;
    try {
      const live = manager();
      if (!live.enabled) {
        facts = { kind: 'disabled' };
      } else {
        const result = await live.downloads();
        if (!result.ok) {
          facts = { kind: 'failed' };
        } else if (Array.isArray(result.body)) {
          facts = { kind: 'listing', direct: listing(result.body) };
        } else {
          facts = { kind: 'listing', jobs: listing(result.body?.jobs), downloads: listing(result.body?.downloads) };
        }
        if (Buffer.byteLength(JSON.stringify(facts)) > MAX_BYTES) facts = { kind: 'failed' };
      }
    } catch {
      facts = { kind: 'fault' };
    }
    json(res, 200, facts);
    return true;
  };
}
module.exports = { createModelDownloadsFacts, PATH };
