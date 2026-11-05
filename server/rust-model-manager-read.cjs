'use strict';
// Row C, PARTIAL: ordinary manager GET forwarding is native. The scan cache has its own
// owner. Autoconfig budget substitution and benchmark evidence publication remain row C's
// Node policy until their authorities move; do not mislabel those paths as native.
const MANAGER_READ_MARKER = 'noevia-model-manager-read-owner/1';
function owned(method, path) {
  if (method !== 'GET' || !path.startsWith('/api/model-manager/') || path === '/api/model-manager/models') return false;
  let rest;
  try { rest = path.slice('/api/model-manager/'.length).split('/').map(decodeURIComponent).join('/'); } catch { return true; }
  return !/^sections\/[^/]+\/autoconfig$/.test(rest) && !/^benchmark\/runs\/\d+$/.test(rest);
}
function refuseOwned(req, res, { parseRequestUrl, json }) {
  const url = parseRequestUrl(req);
  if (!url || !owned(req.method, url.pathname)) return false;
  json(res, 503, { error: 'Model management reads are owned by the Rust front.', code: 'RUST_MODEL_MANAGER_READ_OWNED' });
  return true;
}
module.exports = { MANAGER_READ_MARKER, owned, refuseOwned };
