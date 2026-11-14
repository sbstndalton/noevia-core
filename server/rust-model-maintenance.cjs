'use strict';
// sbstndalton/noevia#2210 (models round B): the Rust front owns the model maintenance authorities
// (noevia-rs bins/noevia-server src/model_maint). A direct Node request for one of the owned
// (method, path) pairs is refused before authentication, whoever asks, so a stale route table cannot
// make two processes answer. Every other method of these paths, and every other model route, stays
// here (routes/models.cjs).
//
// Owned so far:
//   POST /api/models/presets/reload   the router's models.ini re-read, under the inference gate's
//                                     maintenance hold, with the reload guard state file
//   GET  /api/models/evidence         a model's qualification evidence against its live identity
//   POST /api/models/evidence/import  the model-card import (Hugging Face), recorded as external evidence
//
// The evidence store (evidence-<hash>/) is the front's to write. This process's producers (a chat's vision probe
// and MTP acceptance, a benchmark run, auto-tune, a finished download) queue their records in
// evidence-inbox-<hash>/ (evidence-inbox.cjs), which the front drains, and read the log back (evidence.cjs
// createReader). The image recheck is also native (#2286, rust-model-evidence-recheck.cjs);
// its normal inference lease still enters this process's live admission gate.
//
// What stays here with the other model routes, and why (each is chat-bound or engine-live, or reads
// this process's memory): /api/model-manager/* (the folder scan cache, the loader proxy), /api/models/
// load, unload, delete, pull, downloads (chat roles, last-loaded model, leases, the load gate),
// /api/models/preset (GET and PUT: the budget refusal and the preset editor), machines, reranker,
// assignments, idle-unload, prune-missing (all chat-bound), inference-budget PUT (the audit; with NOEVIA_RUST_MODEL_WRITES=rust
// that PUT and the idle-unload PUT are the front's, rust-model-writes.cjs).
//
// The Rust front is the single writer of the reload guard state file (native-preset-reload-<hash>.json) for
// the reloads it makes. This process still makes reloads (the folder sync, delete, prune, idle-unload, the
// preset editor, auto-tune) and records their baselines in the same file under the same lock file
// (preset-reload.cjs), re-reading it on every use. It also asks the inference gate whether a hold it did
// not take is held (inference-maintenance.cjs), so the folder sync, the optional chat work and the code
// machine wait for a hold the front took.
//
// With no inference gate (no admin token, or nothing at the engine address knows the hold), the front's reload takes a
// lease on this process's maintenance gate (model-maintenance-lease.cjs), so it is exclusive with this process's work.
//
// The list is exactly noevia-rs contracts/http/routes.toml's #2210 owner = "rust" rows.
const OWNED = Object.freeze([
  Object.freeze({ method: 'POST', path: '/api/models/presets/reload' }),
  Object.freeze({ method: 'GET', path: '/api/models/evidence' }),
  Object.freeze({ method: 'POST', path: '/api/models/evidence/import' }),
]);
const ROUTE_REFUSAL = Object.freeze({ error: 'Model maintenance is owned by the Rust front.', code: 'RUST_MODEL_MAINTENANCE_OWNED' });

/** True for the exact method and pathname the front owns. */
const owned = (method, pathname) => OWNED.some((o) => o.method === method && o.path === pathname);

/**
 * Runs before authentication, the maintenance gate and the workspace load (index.cjs
 * handleRequestInner). An unparseable target falls through to the ordinary 400.
 */
function refuseOwned(req, res, { parseRequestUrl, json }) {
  if (!OWNED.some((o) => o.method === req.method)) return false;
  const url = parseRequestUrl(req, `http://${req.headers.host || 'localhost'}`) || parseRequestUrl(req);
  if (!url || !owned(req.method, url.pathname)) return false;
  json(res, 503, ROUTE_REFUSAL);
  return true;
}

module.exports = { OWNED, ROUTE_REFUSAL, owned, refuseOwned };
