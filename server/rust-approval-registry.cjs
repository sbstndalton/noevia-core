'use strict';
// Port contract 2026-11-04 S9 (front capability rust-approval-registry): the pending write
// approvals, the routing questions (#778) and the chat-wide "Allow for this chat" grants are the
// Rust front's (noevia-rs approval_registry.rs), next to the public POST /api/tool-approvals/{id}
// that answers them. Node keeps no approval state. Its turn:
//   1. opens the question (POST /v1/approvals/open) BEFORE it shows the card, so an answer can never
//      arrive for a question the front does not know yet;
//   2. waits for it (POST /v1/approvals/wait), a long-poll the front ends with the answer or with a
//      timeout after 5 minutes. When the turn stops (the person left, #679) Node drops that request,
//      and the front withdraws the question: a late answer finds nothing and nothing is "declined".
// chatWideApproved and revokeChatGrant ask the front too (/v1/approvals/{granted,revoke}). The front
// also checks a grant against the chat's live grant context, so a move, a delete or a restart
// revokes it there.
//
// The interface is approvals.cjs's (the in-process reference the chat tests still use), made async,
// plus openApproval/openRouteChoice and one more outcome: 'unavailable' when the front could not be
// asked. It fails closed: an unanswered or unreachable question never approves a write, and a grant
// that cannot be checked is no grant.
//
// What survives a restart: nothing, as before. The front holds every question and grant in memory,
// and the web supervisor restarts the front and Node together under a new start id. A Node-only
// failure drops its waits, which withdraws its questions; a front failure fails Node's waits, which
// end as 'unavailable' (the tool is not run).
const { safeId } = require('./chat-grant-context.cjs');

const OPS = new Set(['open', 'wait', 'cancel', 'granted', 'revoke']);
// The front times a question out itself; Node's own deadline is only a backstop past that.
const WAIT_SLACK_MS = 30000;
// The front's grant lifetime (approval_registry.rs GRANT_TTL): no grant outlives it.
const GRANT_TTL_MS = 60 * 60 * 1000;
// A failed revoke is retried after 1 s, doubling to at most 1 min between tries.
const REVOKE_RETRY = Object.freeze({ firstMs: 1000, maxMs: 60000 });

/** `approvals(op, payload, { wait, signal })` -> { status, body }; it throws an AbortError when
 *  `signal` aborts, and another error when the front cannot be reached (project-store-client.cjs). */
function createApprovalRegistry({ approvals, timeoutMs = 5 * 60 * 1000, log = () => {},
  grantTtlMs = GRANT_TTL_MS, revokeRetry = REVOKE_RETRY, now = Date.now,
  // How a retry is scheduled: (fn, ms) -> handle with clear(). Injected by the tests to run retries
  // deterministically.
  schedule = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return { clear: () => clearTimeout(t) }; } } = {}) {
  const ask = (op, payload, options = {}) => {
    if (!OPS.has(op)) throw new Error(`not an approval op: ${op}`);
    return approvals(op, payload, options);
  };
  const text = (v) => (typeof v === 'string' && v ? v : null);
  const why = (e) => e?.code || e?.name || 'error';

  async function open(kind, { id, userId, chatId = null, scope = null, binding = null }) {
    if (!text(id) || !text(userId)) return false;
    try {
      const payload = { user: userId, id, kind, chat: text(chatId), scope: kind === 'write' ? text(scope) : null, binding: kind === 'write' && binding ? binding : null };
      const { status, body } = await ask('open', payload);
      if (status === 200 && body?.opened === true) return true;
      log(`[tool-approvals] open refused: ${status}${body?.code ? ` ${body.code}` : ''}`);
    } catch (e) {
      log(`[tool-approvals] open failed: ${why(e)}`);
    }
    return false;
  }
  const openApproval = (question) => open('write', question);
  const openRouteChoice = (question) => open('route', question);

  function cancel(userId, id) {
    Promise.resolve().then(() => ask('cancel', { user: userId, id })).catch(() => {});
  }

  // The front's answer body, 'aborted' (the turn stopped) or 'unavailable'.
  async function wait(userId, id, abortSignal) {
    if (abortSignal?.aborted) { cancel(userId, id); return 'aborted'; }
    try {
      const { status, body } = await ask('wait', { user: userId, id }, { wait: timeoutMs + WAIT_SLACK_MS, signal: abortSignal });
      if (status === 200 && body && typeof body.outcome === 'string') return body;
      log(`[tool-approvals] wait refused: ${status}`);
      return 'unavailable';
    } catch (e) {
      // Dropping the request withdrew the question at the front; the cancel is only belt and braces.
      if (abortSignal?.aborted) { cancel(userId, id); return 'aborted'; }
      log(`[tool-approvals] wait failed: ${why(e)}`);
      return 'unavailable';
    }
  }

  /** approvals.cjs awaitApproval, for a question openApproval opened:
   *  'approve' | 'deny' | 'timeout' | 'aborted' | 'unavailable'. Never rejects. */
  async function awaitApproval({ id, userId, abortSignal }) {
    const got = await wait(userId, id, abortSignal);
    if (typeof got === 'string') return got;
    return ['approve', 'deny', 'timeout'].includes(got.outcome) ? got.outcome : 'unavailable';
  }

  /** approvals.cjs awaitRouteChoice, for a question openRouteChoice opened: { choice, remember } or
   *  { choice: 'timeout' | 'aborted' }. A front that cannot be asked is a timeout (the turn stays
   *  local, as routing-modes.cjs treats no answer). Never rejects. */
  async function awaitRouteChoice({ id, userId, abortSignal }) {
    const got = await wait(userId, id, abortSignal);
    if (got === 'aborted') return { choice: 'aborted' };
    if (got !== 'unavailable' && (got.outcome === 'cloud' || got.outcome === 'local')) return { choice: got.outcome, remember: got.remember === true };
    return { choice: 'timeout' };
  }

  // Revocation, in two parts.
  //
  // Epochs. Every revoke Node starts takes a new generation from one monotonic counter, and that
  // generation becomes the chat's revocation epoch. The epoch outlives the revoke's confirmation. A
  // grant check reads the epoch before it asks the front and refuses the answer if the epoch moved
  // meanwhile: a granted:true produced before a revoke can never be accepted after it, whether that
  // revoke was confirmed at once, failed, or was retried. (Revokes the front makes itself, on a move or
  // a delete, change the chat's live context, and the front's own check is atomic with them.)
  //
  // Pending records. A revoke follows a refusal such as "the write target changed after approval";
  // if the front could not be told, its grant would still auto-approve the next write in that chat for
  // a target the person never saw. So an unconfirmed revoke leaves a record, every grant check reads
  // it first and denies, and the revoke is retried with a bounded backoff, one try at a time. The
  // record is cleared only by a confirmation that covers its newest revoke: a confirmation of an older
  // revoke (an explicit call or a retry sent before the newer revoke started) never clears it. It also
  // lapses once no grant it shadows could still be live (a grant lives at most grantTtlMs).
  //
  // Both are in memory and are lost when Node restarts. That is safe: the supervisor restarts the
  // front and Node together under a new start id, and a grant names the start id it was made in, so
  // after a restart no earlier grant applies anyway.
  let generations = 0;
  const epochs = new Map(); // JSON [user, canonical chat] -> { epoch, at }
  const pendingRevokes = new Map(); // same key -> { user, chat, latest, since, delay, timer, trying }
  const revokeKey = (userId, chatId) => JSON.stringify([userId, safeId(chatId)]);
  const epochOf = (key) => epochs.get(key)?.epoch ?? 0;

  function bump(key) {
    const epoch = ++generations;
    epochs.set(key, { epoch, at: now() });
    // Bounded: an epoch only matters to a grant check in flight, far shorter than a grant's life.
    if (epochs.size > 1024) for (const [k, v] of epochs) if (now() - v.at >= grantTtlMs) epochs.delete(k);
    return epoch;
  }

  async function tellFront(userId, chatId) {
    try {
      const { status, body } = await ask('revoke', { user: userId, chat: chatId });
      if (status === 200 && typeof body?.revoked === 'boolean') return { confirmed: true, revoked: body.revoked };
      log(`[tool-approvals] revoke refused: ${status}`);
    } catch (e) {
      log(`[tool-approvals] revoke failed: ${why(e)}`);
    }
    return { confirmed: false, revoked: false };
  }
  function clearRevoke(key, entry) {
    if (pendingRevokes.get(key) !== entry) return;
    entry.timer?.clear();
    entry.timer = null;
    pendingRevokes.delete(key);
  }
  /** A confirmation for revoke `generation`: clears the record only when it covers its newest revoke. */
  function confirmed(key, entry, generation) {
    if (pendingRevokes.get(key) === entry && entry.latest === generation) clearRevoke(key, entry);
  }
  function scheduleRevoke(key, entry) {
    if (pendingRevokes.get(key) !== entry || entry.timer || entry.trying) return;
    entry.timer = schedule(async () => {
      entry.timer = null;
      if (pendingRevokes.get(key) !== entry) return;
      if (now() - entry.since >= grantTtlMs) { clearRevoke(key, entry); return; }
      // The retry covers the revokes started so far, no newer one.
      const covers = entry.latest;
      entry.trying = true;
      const answer = await tellFront(entry.user, entry.chat);
      entry.trying = false;
      if (answer.confirmed) confirmed(key, entry, covers);
      if (pendingRevokes.get(key) !== entry) return;
      if (!answer.confirmed) entry.delay = Math.min(entry.delay * 2, revokeRetry.maxMs);
      scheduleRevoke(key, entry);
    }, entry.delay);
  }
  /** Whether a revoke for this chat still waits for the front's confirmation. */
  function revokePending(userId, chatId) {
    const key = revokeKey(userId, chatId);
    const entry = pendingRevokes.get(key);
    if (entry && now() - entry.since >= grantTtlMs) { clearRevoke(key, entry); return false; }
    return !!entry;
  }

  /** approvals.cjs chatWideApproved, asked of the front. A check without a user, a chat id, a scope
   *  or a binding never matches, and neither does one the front cannot answer, one whose revoke the
   *  front has not yet confirmed, or one a revoke started while it was asked. */
  async function chatWideApproved(userId, chatId, scope, binding) {
    if (!text(userId) || !safeId(chatId) || !text(scope) || !binding) return false;
    const key = revokeKey(userId, chatId);
    if (revokePending(userId, chatId)) return false;
    const epoch = epochOf(key);
    try {
      const { status, body } = await ask('granted', { user: userId, chat: chatId, scope, binding });
      return status === 200 && body?.granted === true && epochOf(key) === epoch && !revokePending(userId, chatId);
    } catch (e) {
      log(`[tool-approvals] grant check failed: ${why(e)}`);
      return false;
    }
  }

  /** approvals.cjs revokeChatGrant, asked of the front. Unconfirmed: recorded and retried (above). */
  async function revokeChatGrant(userId, chatId) {
    if (!text(userId) || !safeId(chatId)) return false;
    const key = revokeKey(userId, chatId);
    // The epoch moves and the record exists before the front is asked, so a grant check racing this
    // revoke is already denied.
    const generation = bump(key);
    let entry = pendingRevokes.get(key);
    if (!entry) {
      entry = { user: userId, chat: chatId, latest: 0, since: 0, delay: revokeRetry.firstMs, timer: null, trying: false };
      pendingRevokes.set(key, entry);
    }
    entry.latest = generation;
    entry.since = now();
    const answer = await tellFront(userId, chatId);
    if (answer.confirmed) { confirmed(key, entry, generation); return answer.revoked; }
    scheduleRevoke(key, entry);
    return false;
  }

  return { openApproval, openRouteChoice, awaitApproval, awaitRouteChoice, chatWideApproved, revokeChatGrant, revokePending };
}

module.exports = { createApprovalRegistry, OPS, WAIT_SLACK_MS, GRANT_TTL_MS, REVOKE_RETRY };
