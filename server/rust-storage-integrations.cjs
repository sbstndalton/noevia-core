'use strict';
// sbstndalton/noevia#2190: the Rust front answers POST /api/integrations/storage/folder, /test and
// /nextcloud/{start,poll,cancel} (noevia-rs bins/noevia-server storage_integration_routes.rs). It
// owns the pending Nextcloud sign-ins (UI_DATA_DIR/nextcloud-login-flows.json, which Node no longer
// opens) and saves a completed sign-in's storage_connections row. Node answered only POST on these
// paths (other methods fell through), so only POST is refused here, before authentication: a stale
// route table cannot make two processes answer.
//
// Node keeps PUT /api/integrations/storage and reads the row on every use (auth.cjs getStorage). The
// storage latch stays here with its automatic callers; a folder write or a test the Rust front ran
// with the saved login writes UI_DATA_DIR/storage-login-proofs.json, which storage-latch.cjs re-reads
// (shared-reread.cjs fileSignal) to end a hold set before the proof.
const OWNED_PATHS = Object.freeze([
  '/api/integrations/storage/folder',
  '/api/integrations/storage/test',
  '/api/integrations/storage/nextcloud/start',
  '/api/integrations/storage/nextcloud/poll',
  '/api/integrations/storage/nextcloud/cancel',
]);
const ROUTE_REFUSAL = Object.freeze({ error: 'Storage integrations are owned by the Rust front.', code: 'RUST_STORAGE_INTEGRATIONS_OWNED' });
const PROOFS_FILE = 'storage-login-proofs.json';

/** The exact pathnames (core compared them exactly). */
const owned = (pathname) => OWNED_PATHS.includes(pathname);

function refuseOwned(req, res, { parseRequestUrl, json }) {
  if (req.method !== 'POST') return false;
  const url = parseRequestUrl(req, `http://${req.headers.host || 'localhost'}`) || parseRequestUrl(req);
  if (!url || !owned(url.pathname)) return false;
  json(res, 503, ROUTE_REFUSAL);
  return true;
}

/** The proofs the Rust front wrote, `{ [userId]: epochMs }`; `{}` when there are none. Throws when the
 *  file exists and cannot be read (the re-reader then answers its fallback). */
function readProofs(file, fsImpl = require('node:fs')) {
  let text;
  try { text = fsImpl.readFileSync(file, 'utf8'); } catch (error) { if (error && error.code === 'ENOENT') return {}; throw error; }
  const doc = JSON.parse(text);
  const proofs = doc && typeof doc === 'object' && doc.proofs && typeof doc.proofs === 'object' && !Array.isArray(doc.proofs) ? doc.proofs : {};
  const out = Object.create(null);
  for (const [userId, at] of Object.entries(proofs)) if (Number.isFinite(at)) out[userId] = at;
  return out;
}

/** A proofOf(userId) for storage-latch.cjs that re-reads the file when its signal changes. */
function createProofReader(dataDir, { path = require('node:path'), reread = require('./shared-reread.cjs') } = {}) {
  const file = path.join(dataDir, PROOFS_FILE);
  const current = reread.createReread({ signal: () => reread.fileSignal(file), load: () => readProofs(file), fallback: () => ({}) });
  return (userId) => { const at = current.current()[userId]; return Number.isFinite(at) ? at : null; };
}

module.exports = { OWNED_PATHS, ROUTE_REFUSAL, PROOFS_FILE, owned, refuseOwned, readProofs, createProofReader };
