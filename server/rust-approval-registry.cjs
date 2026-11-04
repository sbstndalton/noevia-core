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

/** `approvals(op, payload, { wait, signal })` -> { status, body }; it throws an AbortError when
 *  `signal` aborts, and another error when the front cannot be reached (project-store-client.cjs). */
function createApprovalRegistry({ approvals, timeoutMs = 5 * 60 * 1000, log = () => {} }) {
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

  /** approvals.cjs chatWideApproved, asked of the front. A check without a user, a chat id, a scope
   *  or a binding never matches, and neither does one the front cannot answer. */
  async function chatWideApproved(userId, chatId, scope, binding) {
    if (!text(userId) || !safeId(chatId) || !text(scope) || !binding) return false;
    try {
      const { status, body } = await ask('granted', { user: userId, chat: chatId, scope, binding });
      return status === 200 && body?.granted === true;
    } catch (e) {
      log(`[tool-approvals] grant check failed: ${why(e)}`);
      return false;
    }
  }

  /** approvals.cjs revokeChatGrant, asked of the front. */
  async function revokeChatGrant(userId, chatId) {
    if (!text(userId) || !safeId(chatId)) return false;
    try {
      const { status, body } = await ask('revoke', { user: userId, chat: chatId });
      return status === 200 && body?.revoked === true;
    } catch (e) {
      log(`[tool-approvals] revoke failed: ${why(e)}`);
      return false;
    }
  }

  return { openApproval, openRouteChoice, awaitApproval, awaitRouteChoice, chatWideApproved, revokeChatGrant };
}

module.exports = { createApprovalRegistry, OPS, WAIT_SLACK_MS };
