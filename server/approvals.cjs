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
const chatWideApprovals = new Map(); // `${userId}:${chatId}` -> { until, scope }
// #917: a grant also remembers the scope it was given in (the chat route passes the resolved
// project, or the free/diary space). It is honoured only in that same scope, so a request that names
// the chat under another project still gets a card. The key stays `${userId}:${chatId}`, so the
// #814 move revocation still drops the grant whatever scope it holds.
const grantScope = (scope) => (typeof scope === 'string' && scope ? scope : null);
const CHAT_APPROVAL_TTL_MS = ttlMs;

// No chat id means no chat to scope a grant to: id-less requests would otherwise all share
// one `${userId}:-` key, so "approve all" in one would silently cover every other.
function chatApprovalKey(userId, chatId) { return userId && chatId ? `${userId}:${chatId}` : null; }

function chatWideApproved(userId, chatId, scope) {
  if (!chatApprovalKey(userId, chatId)) return false;
  const grant = chatWideApprovals.get(chatApprovalKey(userId, chatId));
  if (!grant) return false;
  if (now() > grant.until) { chatWideApprovals.delete(chatApprovalKey(userId, chatId)); return false; }
  // Fails closed: a check without a scope never matches, and no unscoped grant is ever stored.
  const s = grantScope(scope);
  return s !== null && grant.scope === s;
}

// #814: a chat's "Allow for this chat" grant was given for the project it was in. Moving the chat
// changes which tools (and which targets) its writes reach, so the move revokes the grant and the
// next write asks again. The three actions themselves are unchanged.
function revokeChatGrant(userId, chatId) {
  const key = chatApprovalKey(userId, chatId);
  return key ? chatWideApprovals.delete(key) : false;
}

// Ask the human. Resolves to 'approve' | 'deny', never rejects: the caller
// turns a denial into a tool result the model can read, so a refused call is
// a normal conversational turn rather than a broken stream.
function awaitApproval({ id, userId, chatId, scope, abortSignal, onDecision = () => {} }) {
  return new Promise((resolve) => {
    // Already stopped before the question was asked: nothing to wait for, nothing approved.
    if (abortSignal.aborted) { resolve('aborted'); return; }
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
        if (['approve', 'deny', 'approve_all'].includes(decision)) onDecision(decision);
        if (decision === 'approve_all') {
          // Without a chat id or a scope (#917) this approves this one call only; the grant has
          // nowhere safe to live, so the next write asks again.
          const key = chatApprovalKey(userId, chatId);
          if (key && grantScope(scope)) chatWideApprovals.set(key, { until: now() + CHAT_APPROVAL_TTL_MS, scope: grantScope(scope) });
          finish('approve');
          return true;
        }
        if (decision === 'approve' || decision === 'deny') { finish(decision); return true; }
        return false;
      },
    });
  });
}

// #778: the routing question for a sensitive-looking turn ("Send to cloud / Keep local"). It
// shares the pending map, and so the decision route and its owner check, with the write gate, but
// it never touches a write grant: its answers are its own. Resolves to { choice, remember } or
// { choice: 'timeout' | 'aborted' }; never rejects.
function awaitRouteChoice({ id, userId, chatId, abortSignal }) {
  return new Promise((resolve) => {
    if (abortSignal.aborted) { resolve({ choice: 'aborted' }); return; }
    let settled = false;
    const finish = (answer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abortSignal.removeEventListener('abort', onAbort);
      pendingApprovals.delete(id);
      resolve(answer);
    };
    const timer = setTimeout(() => finish({ choice: 'timeout' }), APPROVAL_TIMEOUT_MS);
    const onAbort = () => finish({ choice: 'aborted' });
    abortSignal.addEventListener('abort', onAbort, { once: true });
    pendingApprovals.set(id, {
      userId,
      chatId,
      kind: 'route',
      decide(decision, extra) {
        if (decision !== 'cloud' && decision !== 'local') return false;
        finish({ choice: decision, remember: extra?.remember === true });
        return true;
      },
    });
  });
}

  return { pendingApprovals, chatWideApproved, revokeChatGrant, awaitApproval, awaitRouteChoice };
}

module.exports = { createApprovals };
