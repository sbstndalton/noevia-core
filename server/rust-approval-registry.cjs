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
  grantTtlMs = GRANT_TTL_MS, revokeRetry = REVOKE_RETRY, now = Date.now } = {}) {
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

  // Revokes the front has not confirmed. A revoke follows a refusal such as "the write target
  // changed after approval"; if the front could not be told, its grant would still auto-approve the
  // next write in that chat for a target the person never saw. So a failed revoke is recorded here,
  // every grant check reads this record first and treats the grant as revoked whatever the front
  // says, and the revoke is retried with a bounded backoff. The record is cleared only once the front
  // confirms the revoke (or once the grant would have expired anyway: a grant lives at most
  // grantTtlMs, and the record is never younger than the grant it shadows).
  // The record is in memory and is lost when Node restarts. That is safe: the supervisor restarts the
  // front and Node together under a new start id, and a grant names the start id it was made in, so
  // after a restart no earlier grant applies anyway.
  const pendingRevokes = new Map(); // JSON [user, canonical chat] -> { user, chat, since, delay, timer }
  const revokeKey = (userId, chatId) => JSON.stringify([userId, safeId(chatId)]);

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
  function clearRevoke(key) {
    const entry = pendingRevokes.get(key);
    if (entry?.timer) clearTimeout(entry.timer);
    pendingRevokes.delete(key);
  }
  function scheduleRevoke(key) {
    const entry = pendingRevokes.get(key);
    if (!entry || entry.timer) return;
    entry.timer = setTimeout(async () => {
      entry.timer = null;
      if (pendingRevokes.get(key) !== entry) return;
      if (now() - entry.since >= grantTtlMs) { clearRevoke(key); return; }
      const { confirmed } = await tellFront(entry.user, entry.chat);
      if (pendingRevokes.get(key) !== entry) return;
      if (confirmed) { clearRevoke(key); return; }
      entry.delay = Math.min(entry.delay * 2, revokeRetry.maxMs);
      scheduleRevoke(key);
    }, entry.delay);
    entry.timer.unref?.();
  }
  /** Whether a revoke for this chat still waits for the front's confirmation. */
  function revokePending(userId, chatId) {
    const key = revokeKey(userId, chatId);
    const entry = pendingRevokes.get(key);
    if (entry && now() - entry.since >= grantTtlMs) { clearRevoke(key); return false; }
    return !!entry;
  }

  /** approvals.cjs chatWideApproved, asked of the front. A check without a user, a chat id, a scope
   *  or a binding never matches, and neither does one the front cannot answer, nor one whose revoke
   *  the front has not yet confirmed. */
  async function chatWideApproved(userId, chatId, scope, binding) {
    if (!text(userId) || !safeId(chatId) || !text(scope) || !binding) return false;
    if (revokePending(userId, chatId)) return false;
    try {
      const { status, body } = await ask('granted', { user: userId, chat: chatId, scope, binding });
      // A revoke that failed while this check was in flight still wins.
      return status === 200 && body?.granted === true && !revokePending(userId, chatId);
    } catch (e) {
      log(`[tool-approvals] grant check failed: ${why(e)}`);
      return false;
    }
  }

  /** approvals.cjs revokeChatGrant, asked of the front. Unconfirmed: recorded and retried (above). */
  async function revokeChatGrant(userId, chatId) {
    if (!text(userId) || !safeId(chatId)) return false;
    const key = revokeKey(userId, chatId);
    // Recorded before asking, so a grant check racing this revoke is already denied.
    const entry = pendingRevokes.get(key) || { user: userId, chat: chatId, since: now(), delay: revokeRetry.firstMs, timer: null };
    entry.since = now();
    pendingRevokes.set(key, entry);
    const { confirmed, revoked } = await tellFront(userId, chatId);
    if (confirmed) { if (pendingRevokes.get(key) === entry) clearRevoke(key); return revoked; }
    scheduleRevoke(key);
    return false;
  }

  return { openApproval, openRouteChoice, awaitApproval, awaitRouteChoice, chatWideApproved, revokeChatGrant, revokePending };
}

module.exports = { createApprovalRegistry, OPS, WAIT_SLACK_MS, GRANT_TTL_MS, REVOKE_RETRY };
