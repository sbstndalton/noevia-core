'use strict';

// #1863: overlap the cold load of the local chat model with the Automatic routing decision.
//
// An Automatic turn asks the decision service which role answers (about 1.5 s), and only then loads the routed
// model (about 9 s cold). When every role the turn could end on names the SAME local model, the decision cannot
// change which model loads, so that load can start now and run beside the decision: time to first token becomes
// about max(load, decision) instead of load + decision.
//
// Conservative on purpose. No pre-load (the turn is exactly as before) when:
//  - the turn is not a local Automatic turn (Manual, another provider, a cloud route from routing modes);
//  - Fast and Smart name different models, Creative names another model, or any assigned chat role is on an
//    Inference machine (the decision, the Creative move or the tool reroute could pick another model);
//  - a Code role names another model and the turn looks like code: the auto-router's own code rule
//    (heuristicWantsCode: a fenced block or a diff), a project with Code context, or a Task (cowork) turn;
//  - the turn carries images (the Vision role may load first) or asks for a long-context profile (another row);
//  - the engine has other work (inferenceBusy: a generation, a load or a swap) or any other model is loaded or
//    loading (a pre-load would evict it, possibly mid-generation or mid-decision);
//  - the model is already loaded or sleeping (nothing to gain).
// A wrong guess (the decision still picks Code) cancels the pre-load as soon as the route is known: the turn stops
// waiting on it and takes its lease on the Code model; the inference gate switches once the pre-loaded model is idle
// (noevia#2115). Nothing in use is ever unloaded: the gate never unloads a model in use, and a pre-load only starts
// on an empty engine. The pre-load's own load holds a lease only while it runs.
const PRELOAD_ROLES = Object.freeze(['fast', 'smart', 'code', 'creative']);

/** The shared Fast/Smart local model when a pre-load is safe for this turn, or null. */
function preloadTarget({ roles, remoteRole = () => null, hasImages = false, contextHigh = false, likelyCode = false } = {}) {
  if (!roles || hasImages || contextHigh) return null;
  const model = roles.fast || roles.smart;
  if (!model || (roles.fast && roles.smart && roles.fast !== roles.smart)) return null;
  if (roles.creative && roles.creative !== model) return null;
  for (const role of PRELOAD_ROLES) if (roles[role] && remoteRole(role)) return null;
  // Last, and only when Code is another model: `likelyCode` may be a function that reads the project (#1863 D3).
  if (roles.code && roles.code !== model && (typeof likelyCode === 'function' ? likelyCode() : likelyCode)) return null;
  return model;
}

/**
 * Start the load of `model` beside the decision, when the engine is idle and empty. Never throws.
 * @returns {{ model: string, pending: () => boolean, settled: Promise<boolean>, cancel: () => void } | null}
 *   null: no pre-load was started (byte-identical turn).
 */
async function startPreload({ manager, model, signal, busy = () => false, log = () => {} }) {
  try {
    if (!model || !manager || manager.kind !== 'llamacpp' || typeof manager.load !== 'function' || typeof manager.listModels !== 'function') return null;
    if (signal?.aborted || busy()) return null;
    const listing = await manager.listModels();
    if (!listing?.ok || !Array.isArray(listing.body?.data)) return null;
    const rows = listing.body.data;
    const row = rows.find((m) => m.id === model);
    if (!row || row.loaded || row.status?.value !== 'unloaded') return null;
    // Anything else resident or arriving (a chat model, a decision model on the engine, the embedding model): a
    // load would evict it or contend with it. Skip; the turn's own load decides as before.
    if (rows.some((m) => m.id !== model && (m.loaded || ['loaded', 'loading', 'sleeping'].includes(m.status?.value)))) return null;
    // This "nothing else loaded" listing can be stale by now. The busy() re-check narrows it: a turn of this server
    // waiting for the inference gate, or a generation in flight, makes busy() true and nothing is pre-loaded. Either
    // way the gate decides the switch, and it never unloads a model in use (noevia#2115).
    if (signal?.aborted || busy()) return null;
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    let done = false;
    const started = Date.now();
    log(`[preload] ${model}: loading beside the routing decision`);
    const settled = Promise.resolve()
      .then(() => manager.load(model, {}, controller.signal))
      .then((r) => { log(`[preload] ${model}: ${r?.ok ? 'ready' : 'not loaded (' + (r?.status || '?') + ')'} after ${Date.now() - started} ms`); return r?.ok === true; },
        () => false)
      .finally(() => { done = true; signal?.removeEventListener('abort', onAbort); });
    let used = false, released = false;
    const cancel = () => controller.abort(new Error('preload not needed'));
    /**
     * #1863 D2: the turn ended before it used the pre-load (an error, or Stop). Once the engine has finished
     * loading it, unload it, so it does not sit resident until the idle unload; only when `idle()` says no other
     * turn is running or waiting and the engine has no other work. Never throws.
     */
    const releaseIfUnused = async ({ idle = () => false, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), settleMs = 1000, waitMs = 120000 } = {}) => {
      if (used || released) return false;
      released = true;
      cancel();
      try {
        await settled;
        // The router goes on loading after a cancel: wait (bounded) until it is loaded or gone.
        const deadline = Date.now() + waitMs;
        let status = null;
        for (;;) {
          await sleep(settleMs);
          if (used) return false;
          const listing = await manager.listModels();
          status = listing?.ok && Array.isArray(listing.body?.data) ? listing.body.data.find((m) => m.id === model)?.status?.value ?? null : null;
          if (status !== 'loading' || Date.now() >= deadline) break;
        }
        if (status !== 'loaded' || used || !idle() || typeof manager.unload !== 'function') return false;
        const r = await manager.unload(model);
        log(`[preload] ${model}: unused by its turn, ${r?.ok ? 'unloaded' : 'left loaded'}`);
        return r?.ok === true;
      } catch { return false; }
    };
    return { model, pending: () => !done, settled, cancel, use: () => { used = true; }, releaseIfUnused };
  } catch {
    return null;
  }
}

module.exports = { preloadTarget, startPreload, PRELOAD_ROLES };
