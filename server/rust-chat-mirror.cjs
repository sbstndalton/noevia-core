'use strict';
// The chat change-journal consumer and the Diary mirror / chat brain schedules are the Rust front's
// (noevia-rs crates/chat-mirror-sched, bins/noevia-server chat_mirror.rs, capability rust-chat-mirror-v1;
// sbstndalton/noevia#2153, #741, #742). It tails each active account's journal, debounces and coalesces the
// mirror passes, times the per-chat brain builds and retries on a backoff. What a pass or a build *does*
// stays here: the Diary file writes and the reasoner call. REMAINING: those two executors.
//
// The front reaches them on loopback with the per-start secret (trusted-front.cjs), one pass at a time per
// account for the mirror and one build at a time for the brains:
//
//   POST /internal/chat-mirror/sync  {user, chats: [id...]}  -> 200 {outcome: 'done' | 'off' | 'failed'}
//   POST /internal/chat-mirror/brain {user, chatId}          -> 200 {reason}
//
// 'off' is a mirror switched off for that account (nothing written, nothing to retry); 'failed' is retried by the
// front on its backoff, with the same chats. Any other answer, or none, is a failed pass there.
//
// This process asks the front for the two things only it sees, over the project store (POST /v1/chat-mirror/*):
// `schedule` when a project change or an import should make an account's mirror look again, and `touch` at a
// request start (the account is active, so their journal is read now). Both are fire-and-forget: a front that
// does not answer loses the nudge, and the front's rescan on its own start covers anything lost.
const { trustedFront } = require('./trusted-front.cjs');

/** Grep marker for noevia deploy/tools/assemble-release.sh and build/web-supervisor.sh: this core leaves the
 *  journal tail and the mirror and brain schedules to the front. */
const RUST_CHAT_MIRROR_OWNED = 'rust-chat-mirror-v1';
const SYNC_PATH = '/internal/chat-mirror/sync';
const BRAIN_PATH = '/internal/chat-mirror/brain';
const USER_CAP = 1024;
const CHATS_CAP = 100000;
/** The front's journal read has a 15-minute activity window; one touch per account per half minute is as good as every request. */
const TOUCH_EVERY_MS = 30000;

/**
 * @param {object} deps
 * @param {string} deps.secret  the per-start secret (an empty one trusts nobody)
 * @param {{ pass: (user: string, chats: string[]) => Promise<'done'|'off'|'failed'> }} deps.mirror
 * @param {{ run: (user: string, chatId: string) => Promise<string> }} deps.brains
 */
function createExecutorBridge({ secret, mirror, brains, json, readJson, log = (m) => console.warn(m) }) {
  // Retain the latest completion per front incarnation. Never evict an incarnation: if the
  // bounded table fills, refuse new ones rather than permitting a stale replay to publish.
  const operations = new Map();
  let brainTail = Promise.resolve();
  const execute = (user, chatId) => {
    const pending = brainTail.then(() => brains.run(user, chatId)).catch(() => 'error');
    brainTail = pending.then(() => {});
    return pending;
  };
  return async function handle(req, res) {
    const path = String(req.url || '').split('?')[0];
    if (path !== SYNC_PATH && path !== BRAIN_PATH) return false;
    // Anything not from the front gets the 404 of an unknown path: with file sharing on, this listener is not loopback only.
    if (!trustedFront(req, secret) || req.method !== 'POST') { json(res, 404, { error: 'Not found' }); return true; }
    let body;
    try { body = await readJson(req, 4 * 1024 * 1024); } catch { json(res, 400, { error: 'invalid JSON' }); return true; }
    const user = body?.user;
    if (typeof user !== 'string' || !user || user.length > USER_CAP) { json(res, 400, { error: 'A user is required.' }); return true; }
    try {
      if (path === SYNC_PATH) {
        const chats = body.chats;
        if (!Array.isArray(chats) || chats.length > CHATS_CAP || !chats.every((c) => typeof c === 'string')) { json(res, 400, { error: 'chats must be a list of chat ids.' }); return true; }
        json(res, 200, { outcome: await mirror.pass(user, chats) });
      } else {
        const chatId = body.chatId;
        if (typeof chatId !== 'string' || !chatId) { json(res, 400, { error: 'A chat id is required.' }); return true; }
        const { incarnation, sequence } = body;
        let pending;
        if (incarnation === undefined && sequence === undefined) {
          pending = execute(user, chatId); // Compatibility: still shares actual execution serialization.
        } else {
          if (typeof incarnation !== 'string' || !/^[a-f0-9]{32}$/.test(incarnation) ||
              !Number.isSafeInteger(sequence) || sequence < 1) {
            json(res, 400, { error: 'invalid operation' }); return true;
          }
          const previous = operations.get(incarnation);
          if (previous && (sequence < previous.sequence ||
              (sequence === previous.sequence && (previous.user !== user || previous.chatId !== chatId)))) {
            json(res, 409, { error: 'stale operation' }); return true;
          }
          if (previous && sequence === previous.sequence) pending = previous.pending;
          else {
            if ((!previous && operations.size >= 64) || (previous && !previous.done)) {
              json(res, 409, { error: 'operation unsettled' }); return true;
            }
            const op = { sequence, user, chatId, done: false };
            pending = op.pending = execute(user, chatId).then(reason => { op.done = true; return reason; });
            operations.set(incarnation, op);
          }
        }
        // A disconnected response is not a cancellation. The caller reconciles this exact
        // promise before releasing its queue; in particular a lost 'built' remains 'built'.
        json(res, 200, { reason: await pending });
      }
    } catch (error) {
      log(`[chat-mirror] executor failed: ${error?.code || error?.name || 'error'}`);
      json(res, 500, { error: 'executor failed' });
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

module.exports = { RUST_CHAT_MIRROR_OWNED, SYNC_PATH, BRAIN_PATH, TOUCH_EVERY_MS, createExecutorBridge, createScheduleClient };
