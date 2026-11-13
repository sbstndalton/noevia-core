'use strict';
// Track R8, the native chat turn: the hand-off from this process's turn preparation to the Rust front's executor,
// and the two tool bridges that executor calls while the tool engines are still this process's.
//
// The front's native executor (noevia-rs bins/noevia-server, behind a per-account switch that is off by default)
// sends a turn to the usual loopback POST /internal/chat/turn (rust-chat-turn.cjs) with one more header,
//
//   x-noevia-chat-handoff: <the per-start secret>
//
// handleChat (chat.cjs) then runs as always up to the end of its preparation: the project, the system message,
// routing, the model, the tools, vision, the stream's first events (meta, sources, telemetry, status, warning,
// tools_scope). A turn the native executor can run ends there with one frame
//
//   data: {"type":"prepared","v":1, ...}      (preparedTurn below; never sent to a browser)
//
// and the front runs the rest: the lease, the context fit, the rounds, the tools, the close, the title and the
// saves. A turn it cannot run yet (refusal() names why) goes on here on the same stream, so the fallback is decided
// before the front writes a byte of its own and nothing runs twice. Without the header, or with the wrong value
// (a browser's header rides along on the relay), nothing here changes the turn.
//
//   POST /internal/chat/tools/execute  {user, projectId, name, args, allowed, routes, chatKey, exchangeKey}
//        -> 200 {text, failed}           one tool call through the toolboxes (index.cjs executeToolCall), as the
//                                        user, counted as chat.cjs counts it (recordToolUse)
//   POST /internal/chat/tools/target   {user, name, args, chatKey}
//        -> 200 {target, kind} | {error} | {}   what a write would change (writeTargetFor, #659), before its card
//
// Both answer 404 to anything that is not the front (trusted-front.cjs): with file sharing on, this listener is not
// loopback only. The permission gate around a call (policy, approval card, audit, grants, recent writes) is the
// native executor's own; these only run what the tool engines do.
const crypto = require('node:crypto');
const { trustedFront } = require('./trusted-front.cjs');

const HANDOFF_HEADER = 'x-noevia-chat-handoff';
const PREPARED_VERSION = 1;
const EXECUTE_PATH = '/internal/chat/tools/execute';
const TARGET_PATH = '/internal/chat/tools/target';
const BODY_CAP = 16 * 1024 * 1024;
const USER_CAP = 200;

/** `requested(req)`: whether the front asked for this turn's hand-off. The header is removed either way. */
function createHandoff({ secret, supervising = () => false }) {
  const want = Buffer.from(String(secret || ''), 'utf8');
  function requested(req) {
    const raw = req?.headers?.[HANDOFF_HEADER];
    if (req?.headers) delete req.headers[HANDOFF_HEADER];
    if (typeof raw !== 'string' || !want.length) return false;
    const got = Buffer.from(raw, 'utf8');
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  }
  return { requested, supervising: () => { try { return supervising() === true; } catch { return true; } } };
}

/**
 * Why the native executor cannot run this turn yet, or null when it can. Every condition is a part of chat.cjs
 * the executor does not do yet; each is lifted when it does. Read at the end of the preparation, so it sees the
 * route, the model and the tools as they were settled.
 */
function refusal(t) {
  if (t.diary) return 'diary';
  if (t.compactOnly) return 'compact';
  if (t.providerId !== t.defaultProviderId || t.machine || t.external || t.chatgpt || t.routeTarget) return 'provider';
  if (t.authorized) return 'provider-key';
  if (t.images || t.messages.some((m) => typeof m?.content !== 'string')) return 'images';
  if (t.skills) return 'skills';
  if (t.provenance) return 'provenance';
  if (t.framingReasoner) return 'framing-reasoner';
  if (t.narrowed) return 'narrowed-tools';
  if (t.gate) return 'tool-gate';
  if (t.supervision) return 'step-supervision';
  if (t.injected) return 'injected-sources';
  if (t.editTools) return 'edit-tools';
  return null;
}

/** The `prepared` frame: everything the native executor needs from here on. No provider key is in it. */
function preparedTurn(t) {
  return {
    type: 'prepared', v: PREPARED_VERSION,
    model: t.model, role: t.role || null, auto: t.auto === true,
    effort: t.effort, thinkingOff: t.thinkingOff === true, sampling: t.sampling || {},
    provider: { id: t.providerId, label: t.providerLabel || t.providerId }, upstreamUrl: t.upstreamUrl,
    // chat.cjs resolveRuntimeLimit's scope (the provider's address and key, hashed there as here).
    limitScope: t.limitScope,
    messages: t.messages, tools: t.tools, routes: t.routes,
    writes: t.writes, public: t.public, automaticOnlyWrites: t.automaticOnlyWrites,
    routeNote: t.routeNote || '', templateGate: t.templateGate === true,
    chat: {
      id: t.chatId || null, contextId: t.contextId || null, key: t.chatKey || null,
      grantScope: t.grantScope, grantHolder: t.grantHolder, recentWrites: t.recentWrites,
      title: t.title,
    },
    turn: {
      message: t.message, spaceId: t.spaceId || null, projectId: t.projectId || null,
      declineEndsReply: t.declineEndsReply === true, record: t.record === true, streamIdleMs: t.streamIdleMs,
    },
  };
}

/**
 * The two tool bridges. `asUser(userId, fn)` runs fn in that user's request scope (index.cjs diaryAsUser), where
 * `currentUser()` is the signed-in user chat.cjs passes as `chatUser` and `currentWorkspace()` theirs.
 */
function createToolBridge({ secret, json, readJson, asUser, getProject, executeToolCall, writeTargetFor, recordToolUse, currentWorkspace, currentUser }) {
  const callerGone = (req, res) => {
    const controller = new AbortController();
    const gone = () => { if (!res.writableEnded) controller.abort(); };
    req.once('close', () => { if (req.destroyed && !req.complete) gone(); });
    res.once('close', gone);
    return controller.signal;
  };
  const text = (v, cap) => (typeof v === 'string' && v.length <= cap ? v : null);
  return async function handle(req, res) {
    const path = String(req.url || '').split('?')[0];
    if (path !== EXECUTE_PATH && path !== TARGET_PATH) return false;
    if (!trustedFront(req, secret) || req.method !== 'POST') { json(res, 404, { error: 'Not found' }); return true; }
    let body;
    try { body = await readJson(req, BODY_CAP); } catch { json(res, 400, { error: 'invalid JSON' }); return true; }
    const user = text(body?.user, USER_CAP);
    const name = text(body?.name, 200);
    const args = text(body?.args, BODY_CAP);
    if (!user || !name || args === null) { json(res, 400, { error: 'user, name and args are required.' }); return true; }
    const chatKey = typeof body.chatKey === 'string' ? body.chatKey : null;
    try {
      if (path === TARGET_PATH) {
        const found = await asUser(user, async () => (typeof writeTargetFor === 'function' ? writeTargetFor(name, args, { user: currentUser(), chatKey }) : null));
        json(res, 200, found && typeof found === 'object' ? found : {});
        return true;
      }
      const allowed = Array.isArray(body.allowed) && body.allowed.every((n) => typeof n === 'string') ? new Set(body.allowed) : null;
      const routes = Array.isArray(body.routes) && body.routes.every((r) => Array.isArray(r) && r.length === 2 && r.every((x) => typeof x === 'string')) ? new Map(body.routes) : null;
      if (!allowed || !routes) { json(res, 400, { error: 'allowed and routes are required.' }); return true; }
      const projectId = typeof body.projectId === 'string' && body.projectId ? body.projectId : null;
      const exchangeKey = typeof body.exchangeKey === 'string' ? body.exchangeKey : null;
      const signal = callerGone(req, res);
      const ran = await asUser(user, async () => {
        const project = projectId ? getProject(projectId) : null;
        if (projectId && !project) return null;
        const outcome = { failed: false };
        const out = await executeToolCall(project, name, args, allowed, signal, outcome, { chatKey, exchangeKey, routes });
        recordToolUse(currentWorkspace(), name);
        return { text: String(out ?? ''), failed: outcome.failed === true };
      });
      if (!ran) { json(res, 404, { error: 'no such project' }); return true; }
      json(res, 200, ran);
    } catch (error) {
      json(res, 500, { error: String(error?.message || 'the tool bridge failed').slice(0, 300) });
    }
    return true;
  };
}

module.exports = { HANDOFF_HEADER, PREPARED_VERSION, EXECUTE_PATH, TARGET_PATH, createHandoff, refusal, preparedTurn, createToolBridge };
