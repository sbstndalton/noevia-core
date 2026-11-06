'use strict';
// sbstndalton/noevia D2: PUT /api/models/preset, the preset editor (validation, the memory-budget check, the
// conditional models.ini commit, the reload under the maintenance hold, the rollback), is the Rust front's
// (noevia-rs bins/noevia-server model_maint/preset_edit.rs, capability rust-preset-editor-d2-v1). A direct Node
// PUT is refused before authentication, whoever asks, so a stale route table cannot make two processes edit the
// same file. GET is rust-preset-read.cjs's; every other method keeps Node's 405 (routes/models.cjs).
// The front tells this process when a write ended so the shared model reads are dropped
// (rust-preset-write-effects.cjs); nothing else of the editor is left in this process.
const OWNED_ROUTES = Object.freeze(new Set(['PUT /api/models/preset']));
const ROUTE_REFUSAL = Object.freeze({ error: 'The preset editor is owned by the Rust front.', code: 'RUST_PRESET_EDITOR_OWNED' });
function refuseOwned(req, res, { parseRequestUrl, json }) {
  if (!OWNED_ROUTES.has(req.method + ' ' + parseRequestUrl(req)?.pathname)) return false;
  json(res, 503, ROUTE_REFUSAL);
  return true;
}
module.exports = { OWNED_ROUTES, ROUTE_REFUSAL, refuseOwned };
