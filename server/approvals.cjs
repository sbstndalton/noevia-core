'use strict';

// The write-approval gate's state: pending single-use approvals and the per-chat
// "allow for this chat" grants. Both live in memory on purpose (see below). The HTTP
// decision route and the chat loop in index.cjs call in; nothing here touches a request.

function createApprovals({ now = Date.now, timeoutMs = 5 * 60 * 1000, ttlMs = 60 * 60 * 1000 } = {}) {
// Pending approvals, keyed by a single-use id. In memory on purpose: an
// approval that outlives the request it belongs to is not useful, and a
// restart should re-ask rather than silently honour a decision made against a
// conversation that no longer exists.
const pendingApprovals = new Map();
const APPROVAL_TIMEOUT_MS = timeoutMs;

// "Approve everything in this chat" — the escape hatch. Scoped to one chat for
// one user and held only in memory, so it expires with the process. A global
// "never ask" default is deliberately NOT offered: the whole point of the gate
// is that someone saw the arguments at least once.
const chatWideApprovals = new Map(); // `${userId}:${chatId}` -> expiresAt
const CHAT_APPROVAL_TTL_MS = ttlMs;

function chatApprovalKey(userId, chatId) { return `${userId}:${chatId || '-'}`; }

function chatWideApproved(userId, chatId) {
  const until = chatWideApprovals.get(chatApprovalKey(userId, chatId));
  if (!until) return false;
  if (now() > until) { chatWideApprovals.delete(chatApprovalKey(userId, chatId)); return false; }
  return true;
}

// Ask the human. Resolves to 'approve' | 'deny', never rejects: the caller
// turns a denial into a tool result the model can read, so a refused call is
// a normal conversational turn rather than a broken stream.
function awaitApproval({ id, userId, chatId, abortSignal }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (decision) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abortSignal.removeEventListener('abort', onAbort);
      pendingApprovals.delete(id);
      resolve(decision);
    };
    // A request that waits forever is a leaked connection. Timing out as a
    // DENIAL rather than an approval is the only safe default.
    const timer = setTimeout(() => finish('timeout'), APPROVAL_TIMEOUT_MS);
    // The user closed the tab or hit stop: nothing was approved.
    const onAbort = () => finish('aborted');
    abortSignal.addEventListener('abort', onAbort, { once: true });
    pendingApprovals.set(id, {
      userId,
      chatId,
      decide(decision) {
        if (decision === 'approve_all') {
          chatWideApprovals.set(chatApprovalKey(userId, chatId), now() + CHAT_APPROVAL_TTL_MS);
          finish('approve');
          return true;
        }
        if (decision === 'approve' || decision === 'deny') { finish(decision); return true; }
        return false;
      },
    });
  });
}

  return { pendingApprovals, chatWideApproved, awaitApproval };
}

module.exports = { createApprovals };
