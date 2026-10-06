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
  unreachableMs = 2 * 60 * 1000, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout,
  adoptRetryMs = 2000, adoptMaxDelayMs = 60 * 1000, adoptAttempts = 10 }) {
  let watching = null, adoptTimer = null, adoptWake = null, adoptCancelled = false;

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
  // Ask until the model manager gives a definitive answer and take the gate back for a running
  // sweep. A manager still starting (no reply, or not ok) is asked again with a doubling delay,
  // at most `adoptAttempts` times (#895); the waits are unref'd and cancelAdopt() cancels them. A busy
  // gate is left alone.
  const pause = (ms) => new Promise((resolve) => {
    adoptWake = resolve;
    adoptTimer = setTimer(() => { adoptTimer = null; adoptWake = null; resolve(); }, ms);
    if (adoptTimer?.unref) adoptTimer.unref();
  });
  async function adopt() {
    let job;
    for (let attempt = 1, delay = adoptRetryMs; ; attempt += 1, delay = Math.min(delay * 2, adoptMaxDelayMs)) {
      if (adoptCancelled) return false;
      let r = null;
      try { r = await progress(); } catch { r = null; }
      if (adoptCancelled) return false;
      if (r?.ok && r.body && typeof r.body === 'object') { job = r.body.job || null; break; }
      if (attempt >= adoptAttempts) { log('[models] throughput sweep: the model manager did not answer after a restart; not adopting.'); return false; }
      await pause(delay);
    }
    // Only a throughput sweep (counted in models) runs outside the engine; the prompt suite does not.
    if (!job || job.active !== true || job.unit !== 'models' || watching) return false;
    let release;
    try { release = acquire(); } catch { return false; }
    log('[models] throughput sweep still running after a restart: chat paused until it finishes.');
    watch(release, Math.max(1, Number(job.total) || 1));
    return true;
  }

  // Cancels a pending adopt() retry (shutdown, tests); adopt() then resolves false.
  function cancelAdopt() {
    adoptCancelled = true;
    if (adoptTimer) { clearTimer(adoptTimer); adoptTimer = null; }
    if (adoptWake) { const wake = adoptWake; adoptWake = null; wake(); }
  }

  return { acquire, watch, adopt, cancelAdopt, active: () => !!watching };
}

module.exports = { createSweepGuard, SWEEP_PAUSE_REASON, SWEEP_BUSY_ERROR };
