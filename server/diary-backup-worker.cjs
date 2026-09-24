'use strict';
// Credentials remain in the existing encrypted account store. Durable progress
// lives with the Diary corpus; this loop resumes it after either service restarts.
//
// Cadence: the tick fires every `interval` ms (default 30 s in production; the
// env override in index.cjs keeps 3 s available for tests/dev, where the
// scale-up would otherwise never be exercised). On top of that shared tick,
// each user carries its own exponential backoff, so a diary that has nothing
// to do — legacy mode, no destination configured yet, or an error — is polled
// less and less often (capped at 10 minutes) instead of hammering Diary every
// tick. A reply that shows real backup work (anything other than legacy/idle)
// resets that user back to the base interval.
const MAX_BACKOFF_MS = 10 * 60 * 1000;

// True when `run(user)`'s reply means "nothing to back up right now": legacy
// mode (no managed corpus yet) or no backup destination configured. Both are
// read straight off the Diary route's reply shapes (see services/diary/agent
// /app.py api_storage_backup / ManagedCorpusBackend.status).
function isIdleReply(reply) {
  if (!reply || typeof reply !== 'object') return true;
  if (reply.mode === 'legacy') return true;
  if (reply.backup === 'not_configured') return true;
  return false;
}

function startDiaryBackupWorker({ users, enabled, run, interval = 30000, onError = () => {} }) {
  let stopped = false, timer;
  // userId -> { backoffMs, nextAt, loggedThisWindow }
  const state = new Map();

  function stateFor(id) {
    let s = state.get(id);
    if (!s) { s = { backoffMs: interval, nextAt: 0, loggedThisWindow: false }; state.set(id, s); }
    return s;
  }

  async function runUser(user, now) {
    const s = stateFor(user.id);
    if (now < s.nextAt) return;
    // A new window has started (we are actually calling `run` again): a fresh
    // failure in it may log once, even if the previous window already logged.
    s.loggedThisWindow = false;
    let reply, failed = false;
    try {
      reply = await run(user);
    } catch {
      failed = true;
    }
    if (failed) {
      if (!s.loggedThisWindow) { onError(user.id); s.loggedThisWindow = true; }
      s.backoffMs = Math.min(MAX_BACKOFF_MS, s.backoffMs * 2);
      s.nextAt = now + s.backoffMs;
      return;
    }
    if (isIdleReply(reply)) {
      s.backoffMs = Math.min(MAX_BACKOFF_MS, s.backoffMs * 2);
      s.nextAt = now + s.backoffMs;
      s.loggedThisWindow = false;
      return;
    }
    // A real, non-idle reply: this user is making backup progress again.
    s.backoffMs = interval;
    s.nextAt = 0;
    s.loggedThisWindow = false;
  }

  async function tick() {
    try {
      const now = Date.now();
      const accounts = users().filter(user => enabled(user.id));
      const known = new Set(accounts.map(user => user.id));
      for (const id of state.keys()) if (!known.has(id)) state.delete(id);
      for (let i = 0; i < accounts.length && !stopped; i += 4) {
        await Promise.all(accounts.slice(i, i + 4).map(user => runUser(user, now)));
      }
    } catch { onError(null); }
    if (!stopped) { timer = setTimeout(tick, interval); timer.unref?.(); }
  }
  timer = setTimeout(tick, interval); timer.unref?.();
  return () => { stopped = true; clearTimeout(timer); };
}
module.exports = { startDiaryBackupWorker };
