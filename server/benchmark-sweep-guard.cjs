'use strict';
// #873: a throughput sweep runs llama-bench in its own container after the model manager
// restarts the engine, so nothing in the web process sees that memory. While it runs, Chat,
// Diary jobs or a calibration could load a router model next to it — two models resident,
// against the one-model inference budget. The web server therefore holds the inference
// maintenance gate from the moment the sweep is accepted until the model manager reports
// it is no longer active (finished, cancelled or failed), and refuses to start one while
// requests are in flight.
//
// The hold is bounded: a sweep runs at most `perModelMs` per model (the sidecar's own
// 30-minute llama-bench timeout) plus `slackMs` for freeing the engine, and a model
// manager that stops answering for `unreachableMs` releases chat rather than pausing it
// indefinitely. The gate lives in memory, so on start the proxy calls adopt() to take it
// back for a sweep that outlived a web restart.

const SWEEP_PAUSE_REASON = 'Chat is paused while noevia runs a throughput sweep. It will be available again when the sweep finishes or is cancelled.';
const SWEEP_BUSY_ERROR = 'Requests are in progress, or a calibration, auto-tune or settings change is running. Wait for it to finish, then start the sweep.';

function createSweepGuard({ hold, progress, log = () => {}, pollMs = 5000, perModelMs = 30 * 60 * 1000, slackMs = 5 * 60 * 1000,
  unreachableMs = 2 * 60 * 1000, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout }) {
  let watching = null;

  // Takes the gate or throws a 409 for the client. Returns a release that is safe to call twice.
  function acquire() {
    try { return hold(SWEEP_PAUSE_REASON); }
    catch { throw Object.assign(Error(SWEEP_BUSY_ERROR), { status: 409, publicMessage: SWEEP_BUSY_ERROR }); }
  }

  // Keeps the gate until the model manager says the sweep is over. `models` bounds the hold.
  function watch(release, models) {
    const deadline = now() + Math.max(1, models) * perModelMs + slackMs;
    let lastSeen = now(), timer = null, done = false;
    const finish = (why) => {
      if (done) return;
      done = true;
      if (timer) clearTimer(timer);
      if (watching === entry) watching = null;
      release();
      if (why) log(`[models] throughput sweep: chat resumed (${why}).`);
    };
    const tick = async () => {
      timer = null;
      if (done) return;
      let job = null;
      try { const r = await progress(); job = r?.ok && r.body && typeof r.body === 'object' ? r.body.job || null : null; } catch { job = null; }
      if (done) return;
      if (job) {
        lastSeen = now();
        if (job.active !== true) return finish('');
      } else if (now() - lastSeen >= unreachableMs) return finish('the model manager stopped answering');
      if (now() >= deadline) return finish('the sweep ran past its time limit');
      timer = setTimer(tick, pollMs);
      if (timer?.unref) timer.unref();
    };
    const entry = { stop: () => finish('') };
    watching = entry;
    timer = setTimer(tick, pollMs);
    if (timer?.unref) timer.unref();
    return entry;
  }

  // After a web restart the gate is gone but a sweep may still be running in its container.
  // Ask once and take the gate back for it; a busy gate or an unreachable manager is left alone.
  async function adopt() {
    let job = null;
    try { const r = await progress(); job = r?.ok && r.body && typeof r.body === 'object' ? r.body.job || null : null; } catch { return false; }
    // Only a throughput sweep (counted in models) runs outside the engine; the prompt suite does not.
    if (!job || job.active !== true || job.unit !== 'models' || watching) return false;
    let release;
    try { release = acquire(); } catch { return false; }
    log('[models] throughput sweep still running after a restart: chat paused until it finishes.');
    watch(release, Math.max(1, Number(job.total) || 1));
    return true;
  }

  return { acquire, watch, adopt, active: () => !!watching };
}

module.exports = { createSweepGuard, SWEEP_PAUSE_REASON, SWEEP_BUSY_ERROR };
