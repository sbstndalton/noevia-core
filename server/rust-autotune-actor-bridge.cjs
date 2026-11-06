'use strict';
// The Rust front owns auto-tune's state (autotune-state-client.cjs; noevia-rs autotune_state.rs). This
// is the front's private way back to the tune actor, which stays here as the runner. It carries
// effects and facts only this process has, never state:
//
//   outside     - models.ini revision, each named model's role and profile, the KV-floor env switch
//   listing     - the router's listing for the queued models (one stage of a resume preparation)
//   identities  - the pending router re-read and the selected queued models' identities
//   abort       - the owner recorded a cancellation: the running tune's abort signal fires
//   launch      - the owner persisted a resumed job as running: this process runs it
//   invalidate  - the model scan cache, after a queue-only resume
//
// Trusted front only (trusted-front.cjs): loopback, not a proxied request, the per-start secret.
// A preparation call ends when the front stops waiting (its connection closes), which fires the
// signal the actor checks between its steps.
const { trustedFront } = require('./trusted-front.cjs');

const PREFIX = '/internal/autotune-actor/';
const OPS = ['outside', 'listing', 'identities', 'abort', 'launch', 'invalidate'];
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_REPLY = 8 * 1024 * 1024;

function createAutotuneActorBridge({ secret, json, readJson, autotune, invalidate = () => {}, log = m => console.warn(m) }) {
  return async function handle(req, res) {
    const path = String(req.url || '').split('?')[0];
    const op = OPS.find(o => path === PREFIX + o);
    if (!op) return false;
    if (req.method !== 'POST' || !trustedFront(req, secret) || Object.hasOwn(req.headers, 'x-forwarded-for') || Object.hasOwn(req.headers, 'x-noevia-client-ip')) { json(res, 404, { error: 'Not found' }); return true; }
    let ask;
    try { ask = await readJson(req, MAX_BYTES); } catch { json(res, 400, { error: 'invalid JSON' }); return true; }
    if (!ask || typeof ask !== 'object' || Array.isArray(ask)) { json(res, 400, { error: 'Invalid actor request.' }); return true; }
    const controller = new AbortController();
    const stop = () => controller.abort();
    const closed = () => { if (!res.writableFinished) stop(); };
    req.once?.('aborted', stop); res.once?.('close', closed);
    try {
      const live = autotune();
      if (!live) { json(res, 503, { error: 'Auto-tune is unavailable.' }); return true; }
      let answer;
      if (op === 'outside') answer = live.outsideFacts(ask.models);
      else if (op === 'listing') answer = await live.listingFacts(ask.items, controller.signal);
      else if (op === 'identities') answer = await live.identityFacts(ask.selectors, controller.signal);
      else if (op === 'abort') answer = live.abort(ask);
      else if (op === 'launch') { answer = await live.launch(ask); if (answer.launched) invalidate(); }
      else { invalidate(); answer = { ok: true }; }
      if (Buffer.byteLength(JSON.stringify(answer)) > MAX_REPLY) throw Error('reply over cap');
      json(res, 200, answer);
    } catch (error) {
      log(`[autotune-actor] ${op} failed: ${error?.code || error?.name || 'error'}`);
      json(res, 503, { error: 'Auto-tune is unavailable.' });
    } finally { req.removeListener?.('aborted', stop); res.removeListener?.('close', closed); }
    return true;
  };
}

/**
 * Binds this process to the state owner and recovers an interrupted run, retrying until the front
 * answers (it may start after this process). `actor` null: the deployment has no tuner, and the
 * owner is told so (the public routes then answer "unavailable" instead of "not ready").
 */
async function attachWhenReady({ actor, unavailableClient, sleep = ms => new Promise(r => setTimeout(r, ms)), log = m => console.warn(m), retryMs = 5000, barrier = () => () => {} }) {
  const release = barrier();
  for (;;) {
    try { await (actor ? actor.attach() : unavailableClient.attach()); break; }
    catch { log('[autotune-actor] waiting for the state owner'); await sleep(retryMs); }
  }
  if (actor) {
    try { await actor.recover(); } catch { log('[autotune-actor] recovery failed'); return; }
  }
  release();
}

module.exports = { createAutotuneActorBridge, attachWhenReady, PREFIX, OPS, MAX_BYTES };
