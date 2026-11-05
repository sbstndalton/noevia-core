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
// manager outage never proves the external work terminated; only a terminal acknowledgement
// releases exclusion. The gate lives in memory, so on start the proxy calls adopt() to take it
// back for a sweep that outlived a web restart.

const SWEEP_PAUSE_REASON = 'Chat is paused while noevia runs a throughput sweep. It will be available again when the sweep finishes or is cancelled.';
const SWEEP_BUSY_ERROR = 'Requests are in progress, or a calibration, auto-tune or settings change is running. Wait for it to finish, then start the sweep.';
// Row J review: the maintenance lease authority (the Rust front) not answering is an outage, not a busy engine.
const SWEEP_UNAVAILABLE_ERROR = 'The maintenance lease authority is not answering, so the sweep was not started. Try again shortly.';
const authorityUnavailable = (e) => e?.status === 503 && e?.code === 'maintenanceAuthorityUnavailable';

function createSweepGuard({ hold, progress, barrier = null, log = () => {}, pollMs = 5000, perModelMs = 30 * 60 * 1000, slackMs = 5 * 60 * 1000,
  unreachableMs = 2 * 60 * 1000, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout,
  adoptRetryMs = 2000, adoptMaxDelayMs = 60 * 1000, adoptAttempts = 10 }) {
  let watching = null, adoptTimer = null, adoptWake = null, adoptCancelled = false;

  // Takes the gate or throws a 409 for the client. Returns a release that is safe to call twice,
  // or (when the hold goes to the inference gate, #2187) a promise of it that rejects with the 409:
  // callers await it.
  function acquire({recovery=false}={}) {
    const refusal = () => Object.assign(Error(SWEEP_BUSY_ERROR), { status: 409, publicMessage: SWEEP_BUSY_ERROR });
    let held;
    // waitable: a refusal that ends on its own (the inference gate's, this process's chat running, or
    // the gate not answering), unlike a hold of this process (a calibration), which is not fought over.
    const waitable = (e) => e?.fromGate === true || e?.chatActive === true || e?.status === 502;
    // An unavailable authority keeps its 503 (and is transient: adopt() waits it out behind a chat barrier).
    const failure = (e) => (authorityUnavailable(e)
      ? Object.assign(Error(SWEEP_UNAVAILABLE_ERROR), { status: 503, code: 'maintenanceAuthorityUnavailable', publicMessage: SWEEP_UNAVAILABLE_ERROR, waitable: true, unavailable: true })
      : Object.assign(refusal(), { waitable: waitable(e) }));
    try { held = hold(SWEEP_PAUSE_REASON,{recovery}); } catch (e) { throw failure(e); }
    if (typeof held?.then === 'function') return held.catch((e) => { throw failure(e); });
    return held;
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
      }
      // Progress outage and local timers are not acknowledgement that the external container stopped.
      // Retain exclusion until an authoritative terminal status arrives, however long it takes.
      timer = setTimer(tick, pollMs);
      if (timer?.unref) timer.unref();
    };
    // Delta review P1: a lease of the front's authority lost while the sweep runs does not end the
    // watch: the sweep is still running in its container, so chat stays closed (this hold is kept
    // locally) until the model manager reports it over or a bound passes; the gate then recovers under
    // a fresh lease before chat resumes.
    const lost = release?.signal;
    const onLost = () => log('[models] throughput sweep: the maintenance lease was lost; chat stays paused until the sweep is over and the model server is checked.');
    if (lost?.aborted) onLost(); else lost?.addEventListener?.('abort', onLost, { once: true });
    const entry = { stop: () => finish(''), lost: () => lost?.aborted === true };
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
    let unbar = typeof barrier === 'function' ? barrier(SWEEP_PAUSE_REASON) : null;
    const lift = () => { unbar?.(); unbar = null; };
    let job;
    for (let attempt = 1, delay = adoptRetryMs; ; attempt += 1, delay = Math.min(delay * 2, adoptMaxDelayMs)) {
      if (adoptCancelled) return false;
      let r = null;
      try { r = await progress(); } catch { r = null; }
      if (adoptCancelled) return false;
      if (r?.ok && r.body && typeof r.body === 'object') { job = r.body.job || null; break; }
      // Unknown progress keeps the restart barrier; a retry count cannot prove termination.
      await pause(delay);
    }
    // Only a throughput sweep (counted in models) runs outside the engine; the prompt suite does not.
    if (!job || job.active !== true || job.unit !== 'models' || watching) { lift(); return false; }
    // #2187: the previous process's gate hold may still be live (it ends when released or after its idle
    // limit), and a chat may be finishing: the hold is asked for again with the same doubling delay, at most
    // adoptAttempts times (the delays add up to well past the gate's 60 s idle limit).
    let release;
    // Row J review: while the lease authority does not answer, chat stays closed behind a barrier (the sweep
    // is known to be running), and the hold is asked for again for as long as the sweep runs, within its bound.
    const bound = now() + Math.max(1, Number(job.total) || 1) * perModelMs + slackMs;
    for (let attempt = 1, delay = adoptRetryMs; ; attempt += 1, delay = Math.min(delay * 2, adoptMaxDelayMs)) {
      if (adoptCancelled) return false;
      if (watching) { lift(); return false; }
      // Only a refusal that ends on its own is waited out; a hold of this process (a calibration) is not fought over.
      let outage = false;
      try { release = await acquire({recovery:true}); break; } catch (e) {
        // Another writer must settle; keep this barrier while checking sweep progress.
        outage = e?.unavailable === true;
      }
      {
        if (!unbar && typeof barrier === 'function') {
          unbar = barrier(SWEEP_PAUSE_REASON);
          log('[models] throughput sweep still running after a restart and the lease authority is not answering: chat paused while the hold is retried.');
        }
        let still = null;
        try { const r = await progress(); still = r?.ok && r.body && typeof r.body === 'object' ? r.body.job || null : undefined; } catch { still = undefined; }
        if (still === null || (still && still.active !== true)) { lift(); log('[models] throughput sweep: finished while chat was paused for it.'); return false; }
        // No local deadline can prove external termination.
      }
      await pause(delay);
    }
    lift();
    if (adoptCancelled || watching) { release(); return false; }
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

module.exports = { createSweepGuard, SWEEP_PAUSE_REASON, SWEEP_BUSY_ERROR, SWEEP_UNAVAILABLE_ERROR };
