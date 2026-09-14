// Credentials remain in the existing encrypted account store. Durable progress
// lives with the Diary corpus; this loop resumes it after either service restarts.
function startDiaryBackupWorker({ users, enabled, run, interval = 3000, onError = () => {} }) {
  let stopped = false, timer;
  async function tick() {
    try {
      const accounts = users().filter(user => enabled(user.id));
      for (let i = 0; i < accounts.length && !stopped; i += 4) {
        await Promise.all(accounts.slice(i, i + 4).map(user => Promise.resolve().then(() => run(user)).catch(() => onError(user.id))));
      }
    } catch { onError(null); }
    if (!stopped) { timer = setTimeout(tick, interval); timer.unref?.(); }
  }
  timer = setTimeout(tick, interval); timer.unref?.();
  return () => { stopped = true; clearTimeout(timer); };
}
module.exports = { startDiaryBackupWorker };
