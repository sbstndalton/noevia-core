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
//   POST /internal/chat/usage          {user, model, reported}
//        -> 204                          the reply's token use, recorded by usage.cjs (recordUsage) as the user:
//                                        this process stays the one writer of the account's usage file
//   POST /internal/chat/prefill        {model, promptTokens, firstTokenMs}
//        -> 204                          one prefill observation for the tool budget (prefill.cjs recordSample)
//   POST /internal/chat/native/health            {}                    -> 200 {ok, body}   modelManager.health()
//   POST /internal/chat/native/load              {model}               -> 200 {ok}         modelManager.load(model)
//   POST /internal/chat/native/tools-allowed     {model}               -> 200 {allowed}    the template tools gate
//   POST /internal/chat/native/tools-unsupported {model}               -> 204              its markUnsupported (#1015)
//   POST /internal/chat/native/busy              {}                    -> 200 {busy}       modelManager.inferenceBusy(1)
//   POST /internal/chat/native/title-auto-named  {user, listId, chatId, firstMessage} -> 200 {autoNamed}
//   POST /internal/chat/native/title-save        {user, listId, chatId, title, firstMessage} -> 204
//        the facts the turn reads of the local model manager, the engine's template and the chat lists, through
//        the same functions chat.cjs calls, while those still live here.
//
// Both answer 404 to anything that is not the front (trusted-front.cjs): with file sharing on, this listener is not
// loopback only, and 404 for an account that does not exist, is disabled or whose workspace was revoked. The
// permission gate around a call (policy, approval card, audit, grants, recent writes) is the native executor's own;
// these only run what the tool engines do. A call that throws answers 500 with the error's message, which the
// executor turns into the call's result as tool-exchange.cjs callError does; a target lookup that throws answers
// chat.cjs's own refusal ({error}).
//
// What the native executor must keep, because this process stops counting the turn at the cut:
// - the model's lease from the cut to the turn's end (the front's admission lease for the model: the gate's
//   one-model queue and the maintenance count). The relayed call's own gate hold is given back when this
//   response ends; the front's S8 admission lease keeps the turn counted for the whole client response.
// - its own copies of this process's per-process state, which then diverge while both executors run (harmless,
//   at most one more warning, card flag or attempt): the recent writes for a card's repeat flag (#658), the title
//   attempts (#1785), the template tools cache (#1002), the rejected effort and budget sets (reasoning-effort.cjs),
//   the prefill samples (step 17) and turnsInFlight (#1863 D2; the admission lease keeps the engine busy instead).
// - tools run against the project as stored when the call runs, not this turn's instruction-skills snapshot; a
//   project with skills is not handed off, so the two differ only by a project change made while the turn runs.
const crypto = require('node:crypto');
const { trustedFront } = require('./trusted-front.cjs');

const HANDOFF_HEADER = 'x-noevia-chat-handoff';
const PREPARED_VERSION = 1;
const EXECUTE_PATH = '/internal/chat/tools/execute';
const TARGET_PATH = '/internal/chat/tools/target';
const USAGE_PATH = '/internal/chat/usage';
const PREFILL_PATH = '/internal/chat/prefill';
const NATIVE_PREFIX = '/internal/chat/native/';
const NATIVE_OPS = new Set(['health', 'load', 'tools-allowed', 'tools-unsupported', 'busy', 'title-auto-named', 'title-save']);
const BODY_CAP = 16 * 1024 * 1024;
const USER_CAP = 200;

/**
 * `requested(req)`: whether the front asked for this turn's hand-off: a turn relayed by the front
 * (rust-chat-turn.cjs relayedUser) carrying the header with the per-start secret. The header is removed either way.
 */
function createHandoff({ secret, supervising = () => false, relayed = (req) => require('./rust-chat-turn.cjs').relayedUser(req) }) {
  const want = Buffer.from(String(secret || ''), 'utf8');
  function requested(req) {
    const raw = req?.headers?.[HANDOFF_HEADER];
    if (req?.headers) delete req.headers[HANDOFF_HEADER];
    if (typeof raw !== 'string' || !want.length || !relayed(req)) return false;
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
  // A chat id that is not text (a hand-made request): chat.cjs's permission checks throw on it, which the
  // native gate does not reproduce, so the turn stays here.
  if (t.chatIdNotText) return 'chat-id';
  if (t.deleted) return 'deleted';
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
  if (t.streamGuard) return 'stream-guard';
  return null;
}

/** The `prepared` frame: everything the native executor needs from here on. No provider key is in it. */
function preparedTurn(t) {
  return {
    type: 'prepared', v: PREPARED_VERSION,
    // When this process began the turn (Date.now()): the reply's time to first token counts from it.
    startedAt: t.startedAt,
    model: t.model, role: t.role || null, auto: t.auto === true,
    effort: t.effort, thinkingOff: t.thinkingOff === true, sampling: t.sampling || {},
    provider: { id: t.providerId, label: t.providerLabel || t.providerId, localEngine: t.providerLocalEngine === true, capabilities: t.providerCapabilities || null },
    upstreamUrl: t.upstreamUrl,
    // chat.cjs resolveRuntimeLimit's scope (the provider's address and key, hashed there as here).
    limitScope: t.limitScope,
    messages: t.messages, tools: t.tools, routes: t.routes,
    writes: t.writes, public: t.public, automaticOnlyWrites: t.automaticOnlyWrites,
    routeNote: t.routeNote || '', templateGate: t.templateGate === true,
    // The local model manager answers health and load (resolveRuntimeLimit), and grants the model's lease.
    managerEnabled: t.managerEnabled === true, modelLease: t.modelLease === true,
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
function createToolBridge({ secret, json, readJson, asUser, getProject, executeToolCall, writeTargetFor, recordToolUse, currentWorkspace, currentUser,
  recordUsage = () => {}, recordSample = () => {}, modelManager = null, templateToolsGate = null, chatTitles = null }) {
  const callerGone = (req, res) => {
    const controller = new AbortController();
    const gone = () => { if (!res.writableEnded) controller.abort(); };
    req.once('close', () => { if (req.destroyed && !req.complete) gone(); });
    res.once('close', gone);
    return controller.signal;
  };
  const text = (v, cap) => (typeof v === 'string' && v.length <= cap ? v : null);
  const names = (v) => (Array.isArray(v) && v.length <= 2000 && v.every((n) => typeof n === 'string' && n.length <= 200) ? v : null);
  const missing = (error) => error?.status === 404;
  const noContent = (res) => { res.statusCode = 204; res.end(); };
  async function nativeFact(op, body, res) {
    const model = text(body?.model, 400);
    const needModel = () => { if (!model) { json(res, 400, { error: 'model is required.' }); return true; } return false; };
    if (op === 'health') {
      const r = modelManager?.enabled ? await modelManager.health() : { ok: false };
      return json(res, 200, { ok: r?.ok === true, body: r?.ok ? r.body ?? null : null });
    }
    if (op === 'load') {
      if (needModel()) return;
      const r = await modelManager.load(model, {});
      return json(res, 200, { ok: r?.ok === true });
    }
    if (op === 'tools-allowed') {
      if (needModel()) return;
      return json(res, 200, { allowed: (await templateToolsGate.allowsTools(modelManager, model)) !== false });
    }
    if (op === 'tools-unsupported') {
      if (needModel()) return;
      templateToolsGate.markUnsupported(model);
      return noContent(res);
    }
    if (op === 'busy') {
      let busy = false;
      try { busy = typeof modelManager?.inferenceBusy === 'function' && modelManager.inferenceBusy(1) === true; } catch { busy = false; }
      return json(res, 200, { busy });
    }
    const who = text(body?.user, USER_CAP), chat = text(body?.chatId, 400), first = text(body?.firstMessage, 1024 * 1024);
    const list = body?.listId === null || body?.listId === undefined ? null : text(body.listId, 400);
    if (!who || !chat || first === null || (body?.listId != null && !list)) return json(res, 400, { error: 'user, chatId and firstMessage are required.' });
    if (op === 'title-auto-named') {
      const autoNamed = await asUser(who, async () => { try { return chatTitles.autoNamed(list, chat, first) === true; } catch { return false; } });
      return json(res, 200, { autoNamed });
    }
    const title = text(body?.title, 400);
    if (!title) return json(res, 400, { error: 'title is required.' });
    await asUser(who, async () => { try { chatTitles.save(list, chat, title, first); } catch { /* the client saves it too */ } });
    return noContent(res);
  }
  return async function handle(req, res) {
    const path = String(req.url || '').split('?')[0];
    const op = path.startsWith(NATIVE_PREFIX) ? path.slice(NATIVE_PREFIX.length) : null;
    if (path !== EXECUTE_PATH && path !== TARGET_PATH && path !== USAGE_PATH && path !== PREFILL_PATH && !NATIVE_OPS.has(op)) return false;
    if (!trustedFront(req, secret) || req.method !== 'POST') { json(res, 404, { error: 'Not found' }); return true; }
    let body;
    try { body = await readJson(req, BODY_CAP); } catch { json(res, 400, { error: 'invalid JSON' }); return true; }
    const count = (v) => (v === null || (Number.isSafeInteger(v) && v >= 0) ? v : undefined);
    if (op) {
      try { await nativeFact(op, body, res); }
      catch (error) {
        if (missing(error)) { json(res, 404, { error: 'no such account' }); return true; }
        json(res, 500, { error: String(error?.message || 'the fact could not be read').slice(0, 300) });
      }
      return true;
    }
    if (path === PREFILL_PATH) {
      const model = text(body?.model, 400), prompt = body?.promptTokens, ms = body?.firstTokenMs;
      if (!model || !Number.isSafeInteger(prompt) || prompt <= 0 || !Number.isFinite(ms) || ms <= 0) { json(res, 400, { error: 'model, promptTokens and firstTokenMs are required.' }); return true; }
      recordSample(model, prompt, ms);
      res.statusCode = 204; res.end(); return true;
    }
    if (path === USAGE_PATH) {
      const who = text(body?.user, USER_CAP), model = text(body?.model, 400), r = body?.reported;
      const reported = r && typeof r === 'object' && !Array.isArray(r)
        ? { promptTokens: count(r.promptTokens), completionTokens: count(r.completionTokens), totalTokens: count(r.totalTokens),
          tokensPerSecond: r.tokensPerSecond === null || (Number.isFinite(r.tokensPerSecond) && r.tokensPerSecond > 0) ? r.tokensPerSecond : undefined } : null;
      if (!who || !model || !reported || Object.values(reported).some((v) => v === undefined)) { json(res, 400, { error: 'user, model and reported are required.' }); return true; }
      try { await asUser(who, async () => recordUsage(currentWorkspace(), model, reported)); }
      catch (error) { if (missing(error)) { json(res, 404, { error: 'no such account' }); return true; } json(res, 500, { error: 'usage not recorded' }); return true; }
      res.statusCode = 204; res.end(); return true;
    }
    const user = text(body?.user, USER_CAP);
    const name = text(body?.name, 200);
    const args = text(body?.args, BODY_CAP);
    if (!user || !name || args === null) { json(res, 400, { error: 'user, name and args are required.' }); return true; }
    const chatKey = body.chatKey === undefined || body.chatKey === null ? null : text(body.chatKey, 200);
    if (chatKey === null && body.chatKey !== undefined && body.chatKey !== null) { json(res, 400, { error: 'chatKey is invalid.' }); return true; }
    try {
      if (path === TARGET_PATH) {
        let found;
        try { found = await asUser(user, async () => (typeof writeTargetFor === 'function' ? writeTargetFor(name, args, { user: currentUser(), chatKey }) : null)); }
        catch (error) {
          if (missing(error)) { json(res, 404, { error: 'no such account' }); return true; }
          // chat.cjs: a lookup that throws refuses the write before its card, with this sentence.
          found = { error: 'The file this would change could not be looked up' };
        }
        json(res, 200, found && typeof found === 'object' ? found : {});
        return true;
      }
      const allowed = names(body.allowed) ? new Set(body.allowed) : null;
      const routes = Array.isArray(body.routes) && body.routes.length <= 2000 && body.routes.every((r) => Array.isArray(r) && r.length === 2 && r.every((x) => typeof x === 'string' && x.length <= 200)) ? new Map(body.routes) : null;
      if (!allowed || !routes) { json(res, 400, { error: 'allowed and routes are required.' }); return true; }
      const projectId = typeof body.projectId === 'string' && body.projectId ? text(body.projectId, 200) : null;
      const exchangeKey = typeof body.exchangeKey === 'string' ? text(body.exchangeKey, 200) : null;
      if ((body.projectId && !projectId) || (body.exchangeKey && !exchangeKey)) { json(res, 400, { error: 'projectId or exchangeKey is invalid.' }); return true; }
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
      if (missing(error)) { json(res, 404, { error: 'no such account' }); return true; }
      json(res, 500, { error: String(error?.message || 'the tool bridge failed').slice(0, 300) });
    }
    return true;
  };
}

module.exports = { HANDOFF_HEADER, PREPARED_VERSION, EXECUTE_PATH, TARGET_PATH, USAGE_PATH, PREFILL_PATH, NATIVE_PREFIX, createHandoff, refusal, preparedTurn, createToolBridge };
