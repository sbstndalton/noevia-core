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
//  - any chat role (fast, smart, code, creative) is on an Inference machine, or the assigned roles name more
//    than one model (the decision, the Creative move, the tool reroute or the Code route could pick another
//    model, and a pre-load would then cost a swap);
//  - the turn carries images (the Vision role may load first) or asks for a long-context profile (another row);
//  - the engine has other work (inferenceBusy: a generation, a load or a swap) or any other model is loaded or
//    loading (a pre-load would evict it, possibly mid-generation or mid-decision);
//  - the model is already loaded or sleeping (nothing to gain).
// The load itself is the manager's own load(): the admission lock, the inference memory budget (#697) and the
// GTT-aware budget all apply as for any load. A refused or failed pre-load is ignored; the turn's own load later
// runs exactly as before and reports the real error. A turn that ends on another model aborts the pre-load.

const PRELOAD_ROLES = Object.freeze(['fast', 'smart', 'code', 'creative']);

/** The one local model every assignable chat role names, or null when a pre-load is not safe. */
function preloadTarget({ roles, remoteRole = () => null, hasImages = false, contextHigh = false } = {}) {
  if (!roles || hasImages || contextHigh) return null;
  const models = new Set();
  for (const role of PRELOAD_ROLES) {
    const model = roles[role];
    if (!model) continue;
    if (remoteRole(role)) return null;
    models.add(model);
  }
  if (models.size !== 1 || !roles.fast && !roles.smart) return null;
  return [...models][0];
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
    return { model, pending: () => !done, settled, cancel: () => controller.abort(new Error('preload not needed')) };
  } catch {
    return null;
  }
}

module.exports = { preloadTarget, startPreload, PRELOAD_ROLES };
