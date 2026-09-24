'use strict';
// POST /api/tool-approvals/:id { decision } -> the human's answer to one pending write.
//
// Returns true when it handled the request. Auth and CSRF run before routes are mounted.
// The gate itself is approvals.cjs; the chat loop parks a write there and waits. This route
// only carries the decision across, and only from the account whose conversation it is:
// a stale, foreign or unknown id all get the same 404, so it cannot be used to probe.

const { isJsonObject } = require('../http.cjs');

const PASS = Symbol('unhandled');

/**
 * @param {object} deps
 * @param {(res, status, body) => any} deps.json
 * @param {(req) => Promise<string>} deps.readBody
 * @param {Map<string, { userId:string, decide:(decision:string) => boolean }>} deps.pendingApprovals
 * @param {{ getStore: () => any }} deps.requestScope
 */
function createApprovalRoutes({ json, readBody, pendingApprovals, requestScope }) {
  async function handle(req, res, { path: p }) {
    const approvalMatch = p.match(/^\/api\/tool-approvals\/([^/]+)$/);
    if (approvalMatch && req.method === 'POST') {
      const id = decodeURIComponent(approvalMatch[1]);
      const raw = await readBody(req);
      let body;
      try { body = JSON.parse(raw); } catch { return json(res, 400, { error: 'invalid JSON' }); }
      if (!isJsonObject(body)) return json(res, 400, { error: 'request body must be a JSON object' });
      const pending = pendingApprovals.get(id);
      // Already decided, timed out, or never existed — all the same answer, so
      // a stale id cannot be used to probe which approvals are outstanding.
      if (!pending) return json(res, 404, { error: 'no such pending approval' });
      // The approval must come from the user whose conversation it is. Without
      // this, any signed-in member could approve another member's write.
      const userId = requestScope.getStore()?.workspace?.userId || null;
      if (!userId || pending.userId !== userId) return json(res, 404, { error: 'no such pending approval' });
      if (!pending.decide(String(body.decision || ''))) {
        return json(res, 400, { error: "decision must be 'approve', 'deny' or 'approve_all'" });
      }
      return json(res, 200, { ok: true });
    }
    return PASS;
  }

  return async function approvalRoutes(req, res, ctx) {
    return (await handle(req, res, ctx)) !== PASS;
  };
}

module.exports = { createApprovalRoutes };
