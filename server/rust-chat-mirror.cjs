'use strict';
// The chat change-journal consumer, the Diary mirror / chat brain schedules AND their work are the Rust front's
// (noevia-rs crates/chat-mirror-sched and crates/chat-mirror-exec, bins/noevia-server chat_mirror.rs and
// chat_mirror_work.rs; capabilities rust-chat-mirror-v1 and rust-chat-mirror-exec-v1; sbstndalton/noevia#2153,
// #741, #742). The front writes the vault notes, the per-user index, the Trash moves and the brains itself, and
// builds the reasoner's prompt, schema and parameters.
//
// What stays here is the engine seam: the answer model, the reasoner's admission (keep-alongside list and load
// budget, framing-reasoner.cjs admitReasoner) and the call on the default provider (createEngineCompletion), which
// still belong to this process. The front reaches it on loopback with the per-start secret (trusted-front.cjs):
//
//   POST /internal/chat-mirror/engine {op: 'loaded'}                       -> 200 {model: string|null}
//   POST /internal/chat-mirror/engine {op: 'admit', model, answerModel}    -> 200 {refusal: string|null}
//   POST /internal/chat-mirror/engine {op: 'complete', model, schema, messages} -> 200 {content} | 502
//   POST /internal/chat-mirror/engine {op: 'record', entry}                -> 204 (the decision log, 'chat-brain')
//
// A client that goes away aborts the engine call (its response closes), and so does a 35 s deadline of its own. REMAINING: when the front owns the engine admission (row H) and
// the provider registry, this seam goes too.
//
// This process asks the front for the two things only it sees, over the project store (POST /v1/chat-mirror/*):
// `schedule` when a project change or an import should make an account's mirror look again, and `touch` at a
// request start (the account is active, so their journal is read now). Both are fire-and-forget: a front that
// does not answer loses the nudge, and the front's rescan on its own start covers anything lost.
const { trustedFront } = require('./trusted-front.cjs');

/** Grep marker for noevia deploy/tools/assemble-release.sh and build/web-supervisor.sh: this core leaves the
 *  journal tail and the mirror and brain schedules to the front. */
const RUST_CHAT_MIRROR_OWNED = 'rust-chat-mirror-v1';
/** Grep marker: this core has no mirror or brain executor; the front does that work (only the engine seam is here). */
const RUST_CHAT_MIRROR_EXEC_OWNED = 'rust-chat-mirror-exec-v1';
const ENGINE_PATH = '/internal/chat-mirror/engine';
const MODEL_CAP = 512;
/** The front gives a reasoner call 30 s (crates/chat-mirror-exec brain DEFAULT_DEADLINE) and drops it then; a call it
 *  could not drop (a lost connection nobody noticed) still ends here. */
const COMPLETE_DEADLINE_MS = 35000;
/** The front's journal read has a 15-minute activity window; one touch per account per half minute is as good as every request. */
const TOUCH_EVERY_MS = 30000;

/**
 * The engine seam. `loaded()` is the model the local engine has loaded (or null); `admit(model, ctx)` is
 * framing-reasoner.cjs admitReasoner's answer (null or a refusal reason); `complete({model, schema, messages, signal})`
 * is createEngineCompletion. Nothing here builds a prompt or picks a parameter.
 * @param {object} deps
 * @param {string} deps.secret  the per-start secret (an empty one trusts nobody)
 */
function createEngineSeam({ secret, loaded, admit, complete, record = () => {}, json, readJson, log = (m) => console.warn(m), completeDeadlineMs = COMPLETE_DEADLINE_MS }) {
  return async function handle(req, res) {
    const path = String(req.url || '').split('?')[0];
    if (path !== ENGINE_PATH) return false;
    // Anything not from the front gets the 404 of an unknown path: with file sharing on, this listener is not loopback only.
    if (!trustedFront(req, secret) || req.method !== 'POST') { json(res, 404, { error: 'Not found' }); return true; }
    let body;
    try { body = await readJson(req, 4 * 1024 * 1024); } catch { json(res, 400, { error: 'invalid JSON' }); return true; }
    const model = body?.model;
    const okModel = (m) => typeof m === 'string' && m.length > 0 && m.length <= MODEL_CAP;
    try {
      if (body?.op === 'record') {
        const entry = body.entry;
        const ok = entry && typeof entry === 'object' && !Array.isArray(entry) && ['brain.fallback', 'brain.built'].includes(entry.event);
        if (!ok) { json(res, 400, { error: 'A brain entry is required.' }); return true; }
        try { record(entry); } catch { /* logging never changes the outcome */ }
        res.writeHead(204); res.end();
        return true;
      }
      if (body?.op === 'loaded') { json(res, 200, { model: (await loaded()) || null }); return true; }
      if (body?.op === 'admit') {
        const answerModel = body.answerModel ?? null;
        if (!okModel(model) || (answerModel !== null && !okModel(answerModel))) { json(res, 400, { error: 'A model is required.' }); return true; }
        const refusal = await admit(model, { answerModel, answerIsLocal: !!answerModel });
        json(res, 200, { refusal: refusal || null });
        return true;
      }
      if (body?.op === 'complete') {
        if (!okModel(model) || !Array.isArray(body.messages) || !body.schema || typeof body.schema !== 'object') { json(res, 400, { error: 'A model, a schema and messages are required.' }); return true; }
        // The call ends when the front goes away (its own deadline dropped the request): the RESPONSE closes then,
        // not the request, whose 'close' already fired once the body was read. A front already gone before the call
        // starts never starts it. An independent deadline ends a call nobody ends otherwise. Listeners go when done.
        const controller = new AbortController();
        const abort = () => { if (!controller.signal.aborted) controller.abort(); };
        const onClose = () => { if (!res.writableEnded) abort(); };
        res.on?.('close', onClose);
        const timer = setTimeout(abort, completeDeadlineMs);
        timer.unref?.();
        if (res.destroyed || req.socket?.destroyed) abort();
        try {
          if (controller.signal.aborted) throw Object.assign(new Error('the front went away'), { name: 'AbortError' });
          const content = await complete({ model, schema: body.schema, messages: body.messages, signal: controller.signal });
          if (!res.destroyed) json(res, 200, { content });
        } catch (error) {
          log(`[chat-mirror] engine call failed: ${error?.status || error?.code || error?.name || 'error'}`);
          if (!res.destroyed) json(res, 502, { error: 'engine call failed' });
        } finally {
          clearTimeout(timer);
          res.off?.('close', onClose);
        }
        return true;
      }
      json(res, 400, { error: 'Unknown op.' });
    } catch (error) {
      log(`[chat-mirror] engine seam failed: ${error?.code || error?.name || 'error'}`);
      json(res, 500, { error: 'engine seam failed' });
    }
    return true;
  };
}

/**
 * The two nudges to the front's schedule. `store` is the project store client (chatMirrorSchedule,
 * chatMirrorTouch). Never throws, never waits for the front.
 */
function createScheduleClient({ store, log = (m) => console.warn(m), now = Date.now }) {
  const touched = new Map(); // user -> time of the last touch sent
  let failing = false;
  const send = (promise) => {
    promise.then(() => { failing = false; }, (error) => {
      if (!failing) { failing = true; log(`[chat-mirror] the front's schedule did not take a nudge: ${error?.status || error?.code || error?.name || 'error'}`); }
    });
  };
  return {
    /** The account's mirror should look again: at `chatId`, or at everything when null. */
    schedule(userId, chatId = null, { immediate = false } = {}) {
      if (typeof userId !== 'string' || !userId) return;
      try { send(Promise.resolve(store.chatMirrorSchedule(userId, chatId, immediate))); } catch (error) { send(Promise.reject(error)); }
    },
    /** A request from the account started: they are active. */
    touch(userId) {
      if (typeof userId !== 'string' || !userId) return;
      const at = now();
      if (touched.has(userId) && at - touched.get(userId) < TOUCH_EVERY_MS) return;
      touched.set(userId, at);
      if (touched.size > 10000) touched.delete(touched.keys().next().value);
      try { send(Promise.resolve(store.chatMirrorTouch(userId))); } catch (error) { send(Promise.reject(error)); }
    },
  };
}

module.exports = { RUST_CHAT_MIRROR_OWNED, RUST_CHAT_MIRROR_EXEC_OWNED, ENGINE_PATH, TOUCH_EVERY_MS, createEngineSeam, createScheduleClient };
