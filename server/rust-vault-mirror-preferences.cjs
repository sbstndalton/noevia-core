'use strict';
// sbstndalton/noevia#2190 round 3: the Rust front answers GET|PUT /api/chat-vault-mirror/preferences
// (noevia-rs crates/server-account vault_mirror.rs) and is the only writer of
// users/<id>/chat-vault-mirror.json; the mirror here keeps reading it on every use
// (chat-vault-mirror.cjs readPreferences). Node's route answered every method on the exact path
// (405 for the others), so every method is refused here, before authentication: a stale route
// table cannot make two processes answer.
//
// Node's PUT scheduled the account's mirror at once when it turned the mirror on. The mirror stays
// here, so the Rust front writes UI_DATA_DIR/chat-vault-mirror-nudges.json
// ({version:1,nudges:{<userId>:<epochMs>}}) and startNudges re-reads it by its file signal and
// schedules each account whose nudge is newer than the last one seen (the first read is the
// baseline: a restart does not replay old nudges). The mirror applies its own enabled(userId) gate.
const PATH = '/api/chat-vault-mirror/preferences';
const ROUTE_REFUSAL = Object.freeze({ error: 'Chat vault mirror preferences are owned by the Rust front.', code: 'RUST_VAULT_MIRROR_PREFERENCES_OWNED' });
const NUDGES_FILE = 'chat-vault-mirror-nudges.json';

function refuseOwned(req, res, { parseRequestUrl, json }) {
  const url = parseRequestUrl(req, `http://${req.headers.host || 'localhost'}`) || parseRequestUrl(req);
  if (!url || url.pathname !== PATH) return false;
  json(res, 503, ROUTE_REFUSAL);
  return true;
}

/** `{ [userId]: epochMs }`; `{}` when the file is missing. Throws when it exists and cannot be read. */
function readNudges(file, fsImpl = require('node:fs')) {
  let text;
  try { text = fsImpl.readFileSync(file, 'utf8'); } catch (error) { if (error && error.code === 'ENOENT') return {}; throw error; }
  const doc = JSON.parse(text);
  const nudges = doc && typeof doc === 'object' && doc.nudges && typeof doc.nudges === 'object' && !Array.isArray(doc.nudges) ? doc.nudges : {};
  const out = Object.create(null);
  for (const [userId, at] of Object.entries(nudges)) if (Number.isFinite(at)) out[userId] = at;
  return out;
}

/**
 * Polls the nudges and calls schedule(userId, null, { immediate: true }) for each new one.
 * Returns { tick, stop }; tick() runs one pass (tests drive it directly).
 */
function startNudges({ dataDir, schedule, intervalMs = 2000, path = require('node:path'), reread = require('./shared-reread.cjs'), log = console.warn, timers = { setInterval, clearInterval } }) {
  const file = path.join(dataDir, NUDGES_FILE);
  let failed = false;
  const current = reread.createReread({
    signal: () => reread.fileSignal(file),
    load: () => readNudges(file),
    fallback: () => { if (!failed) { failed = true; log('[chat-vault-mirror] nudges could not be read'); } return null; },
  });
  let seen = null;
  const tick = () => {
    const nudges = current.current();
    if (!nudges) return;
    failed = false;
    if (!seen) { seen = { ...nudges }; return; }
    for (const [userId, at] of Object.entries(nudges)) {
      if (seen[userId] !== undefined && at <= seen[userId]) continue;
      seen[userId] = at;
      try { schedule(userId, null, { immediate: true }); } catch { log('[chat-vault-mirror] nudge could not be scheduled'); }
    }
  };
  tick();
  const handle = intervalMs > 0 ? timers.setInterval(tick, intervalMs) : null;
  if (handle && typeof handle.unref === 'function') handle.unref();
  return { tick, stop: () => { if (handle) timers.clearInterval(handle); } };
}

module.exports = { PATH, ROUTE_REFUSAL, NUDGES_FILE, refuseOwned, readNudges, startNudges };
