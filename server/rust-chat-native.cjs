'use strict';
// Track R8, the native chat turn: the hand-off from this process's turn preparation to the Rust front's executor,
// and the tool bridges that executor calls while the tool engines are still this process's.
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
//   x-noevia-chat-handoff-caps: skills      (comma-separated tokens; with the secret only, else ignored)
//
// names what the front's executor runs beyond the first hand-off step, so a front older than core never gets a
// turn it would run without its checks: `skills` (W5) its instruction skills checks (the skills bridges below);
// `once` (#2446) the coworker page save's per-call card (never under a chat-wide grant, `once` on the card and its
// question, an `allow` policy read as `ask`; the prepared frame names those tools in `onceTools`); `provenance` (#769,
// track R15) the provenance policy's write checks (provenance-policy.cjs: each round's untrusted text taken in, a write
// whose sensitive arguments hold some asked about on its own card even under "Allow for this chat", audited
// `tool.provenance`; the prepared frame says `provenance: true` when the policy is on for the turn); `more-tools`
// (Roadmap E, R15) the routed list's more_tools call: the prepared frame's `widen` (only on a routed turn whose list
// was narrowed) is the project's whole selection as the round loop would resolve it, and the executor answers
// more_tools from it as chat.cjs does; `retrieved-images` (#1726, R15) a turn with retrieved images: everything
// chat.cjs does with them happens before the cut (the system note, captions or the images' own text, the image
// parts and their label on the last user message, the warning), so the frame's messages carry them and the
// executor sends them as it sends attached images; `supervise` (R15) step supervision after a tool round (the
// supervise op below; the frame says `supervise: true`).
// Without it a turn whose project has instruction skills stays here ('skills'), a coworker turn offering the page
// save too ('page-save'), every turn while the provenance policy is on ('provenance'), a turn whose tools were
// narrowed by routing ('narrowed-tools'), one with retrieved images ('retrieved-images'), and every turn while step
// supervision is on ('step-supervision'). The header is removed either way.
//
//   POST /internal/chat/tools/execute  {user, projectId, name, args, allowed, routes, chatKey, exchangeKey, editTarget?, grant?}
//        -> 200 {text, failed} | {text, failed, notRun: true} | {redeem: 'refused' | 'unavailable' | 'aborted'}
//                                        one tool call through the toolboxes (index.cjs executeToolCall), as the
//                                        user, counted as chat.cjs counts it (recordToolUse). `editTarget`: an
//                                        approved project file edit's pinned file (targetDigest, 64 hex), passed
//                                        in the call's options as chat.cjs passes it (#648). `notRun`: the executor
//                                        refused at its outbound write (a closed write fence, tool-write-fence.cjs);
//                                        the call is not counted. `grant` {handle, chat, scope, binding} (with an
//                                        exchangeKey): the call runs under a chat-wide grant the grant bridge
//                                        found. The handle is taken out first; then the grant is redeemed at the
//                                        front (rust-approval-registry.cjs redeemChatGrant, with the call's final
//                                        `binding`) and the call runs inside the redeemed dispatch fence, as
//                                        chat.cjs runs it (writeFence; started() when it ends). `refused`: the
//                                        handle is unknown, expired or not this call's, or the front refused the
//                                        redeem, or the grant was revoked meanwhile; `unavailable`: the redeem could
//                                        not be asked, or its window closed before the call; `aborted`: the call's
//                                        signal was aborted (the abort bridge, or the front's call went away) by
//                                        the time the redeem answered (chat.cjs: "exchange cancelled; tool was not
//                                        run."). None of them runs the call; the fence is retired (started()).
//   POST /internal/chat/tools/grant    {user, chat, scope, binding, exchangeKey}
//        -> 200 {granted: false} | {granted: true, handle}   whether a chat-wide grant ("Allow for this chat")
//                                        covers this write (chatWideApproved, asked of the front), as chat.cjs
//                                        asks it before the card. The registry's ticket stays here; the executor
//                                        gets a handle (32 hex) to name it in the execute call. A grant handle is
//                                        single use, bound to user, chat, scope and exchange; an unknown or
//                                        mismatched handle never runs the call. Handles live 5 minutes, at most
//                                        64 per account and 1024 in all (when full: granted false, the card asks).
//   POST /internal/chat/tools/revoke   {user, chat}
//        -> 200 {revoked} | 503 {error}  revokeChatGrant, as chat.cjs revokes a chat's grant after a target or
//                                        permission check fails (Node's epoch moves first; an unconfirmed revoke is
//                                        retried there). 503 when this process has no approval registry.
//   POST /internal/chat/tools/target   {user, name, args, chatKey}
//        -> 200 {target, kind} | {error} | {}   what a write would change (writeTargetFor, #659), before its card
//   POST /internal/chat/tools/abort    {user, exchangeKey}
//        -> 204                          aborts the signal of every execute call of that exchange still running (the
//                                        native turn's client left: chat.cjs's tools get the turn's signal then); each
//                                        call still answers with what its tool returned
//   POST /internal/chat/tools/edit-target {user, projectId, name, args}
//        -> 200 {path, account, digest} | {error}   the stored file a project edit tool (EDIT_TOOLS) would change
//                                        (#648/#687: project-edit-target.cjs resolveEditTarget against the project as
//                                        stored now, with the user's storage account), and the digest the call is
//                                        pinned to (targetDigest(path, account)). chat.cjs resolves it before the
//                                        card, after the answer and right before the run; so does the executor.
//   POST /internal/chat/usage          {user, model, reported}
//        -> 204                          the reply's token use, recorded by usage.cjs (recordUsage) as the user:
//                                        this process stays the one writer of the account's usage file
//   POST /internal/chat/prefill        {user, model, promptTokens, firstTokenMs}
//        -> 204                          one prefill observation for the tool budget (prefill.cjs recordSample)
//   POST /internal/chat/native/health            {user}                -> 200 {ok, body}   modelManager.health()
//   POST /internal/chat/native/load              {user, model, lease}  -> 200 {ok}         modelManager.load(model)
//        `lease` is the value of the front's X-Noevia-Lease header for this turn (its admission lease's gate
//        token), or null when the front holds none (no gate answers at the engine address). The load runs inside
//        that lease, as chat.cjs's explicit load runs inside the turn's (chat-context.cjs resolveManagedLimit), so
//        it takes no second lease; with null it is chat.cjs's load without a lease. It stops when the front's call
//        goes away.
//   POST /internal/chat/native/tools-allowed     {user, model}         -> 200 {allowed}    the template tools gate
//   POST /internal/chat/native/tools-unsupported {user, model}         -> 204              its markUnsupported (#1015)
//   POST /internal/chat/native/busy              {user, own}           -> 200 {busy}       modelManager.inferenceBusy(own)
//        `own`: the counts the asking turn holds in this process's gate (1..8, default 1). chat.cjs's turn holds one;
//        a native turn holds the route's admission lease and, while it lasts, the model's lease.
//   POST /internal/chat/native/title-auto-named  {user, listId, chatId, firstMessage} -> 200 {autoNamed}
//   POST /internal/chat/native/title-save        {user, listId, chatId, title, firstMessage} -> 204
//   POST /internal/chat/native/tool-used         {user, name}          -> 204              recordToolUse (track R13): a
//        tool call the front answered itself (read_project_file behind NOEVIA_RUST_READ_FILE) is counted here, as the
//        execute bridge counts a call it runs; core stays the usage store's single writer.
//        the facts the turn reads of the local model manager, the engine's template and the chat lists, through
//        the same functions chat.cjs calls, while those still live here. health and load answer 409 {enabled:false}
//        when the local model manager is off; the executor never calls them then (the prepared frame's
//        managerEnabled is false).
//   POST /internal/chat/skills/revoked  {user, projectId, loaded: [{file, hash, name}]}
//        -> 200 {gone: [{file, name}]}   the loaded skills that are gone, disabled, changed or no longer reviewed in
//                                        the project as stored now (#272: instruction-skills.cjs revoked, as chat.cjs
//                                        revokedSkills asks it); a project that is gone revokes them all
//   POST /internal/chat/skills/read     {user, projectId, chatId, candidates: [{file, hash, name}], args, result}
//        -> 200 {loaded: [{file, hash, name}]}   which candidates (the prepared frame's enabled skills the turn has
//                                        not loaded yet) one successful tool call read (skill-reads.cjs, as chat.cjs
//                                        noteSkillRead), each recorded in the account's skill ledger for the chat
//                                        (skill-history.cjs record, chat.cjs rememberSkill)
//   POST /internal/chat/skills/scrub    {user, projectId, chatId, messages: [{role, content} | null]}
//        -> 200 {changed: [[index, content]], removed: [names]}   #546's scrub of the round-0 messages against the
//                                        project as stored now (skill-history.cjs scrub, as chat.cjs runs it before its
//                                        first round). `messages` holds what the scrub reads (null for a user or
//                                        system message and for one whose content is not text); `changed` the new
//                                        content of each message it replaced, `removed` the skill names it took out.
//
// Every bridge answers 404 to anything that is not the front (trusted-front.cjs): with file sharing on, this
// listener is not loopback only. Every one names the relayed user (`user`) and runs as that user (index.cjs
// chatNativeAsUser, createAsUser below), and answers 404 {error:'no such account'} for an account that does not
// exist, is disabled or whose workspace was revoked or removed. A field that is missing or malformed answers 400;
// a `model` may not carry control characters. The permission gate around a call (policy, approval card, audit,
// recent writes) is the native executor's own; these only run what the tool engines do. The chat-wide grants are
// the one exception: their check, redeem and revoke go through this process's approval registry (index.cjs
// approvalRegistry, the one chat.cjs uses), whose revocation epochs the front's revokes move (frontRevoked). A tool call that
// throws answers 500 with the error's message, which the executor turns into the call's result as
// tool-exchange.cjs callError does; a target lookup that throws answers chat.cjs's own refusal ({error}), and so does
// an edit target lookup that throws (resolveEditTarget never does; reading the project can); a fact that cannot be
// read answers 500 with a fixed text (the detail is logged here, never sent).
//
// What the native executor must keep, because this process stops counting the turn at the cut:
// - the model's lease from the cut to the turn's end (the front's admission lease for the model: the gate's
//   one-model queue and the maintenance count). The relayed call's own gate hold is given back when this
//   response ends; the front's S8 admission lease keeps the turn counted for the whole client response.
// - its own copies of this process's per-process state, which then diverge while both executors run (harmless,
//   at most one more warning, card flag or attempt): the recent writes for a card's repeat flag (#658), the title
//   attempts (#1785), the rejected effort and budget sets (reasoning-effort.cjs),
//   the prefill samples (step 17) and turnsInFlight (#1863 D2; the admission lease keeps the engine busy instead).
//   The template tools cache (#1002) is not among them: the tools-allowed and tools-unsupported bridges read and
//   write this process's shared gate (chat-template-caps.cjs toolsGate), the one chat.cjs uses.
// - tools run against the project as stored when the call runs, not this turn's instruction-skills snapshot, and
//   the skills/read bridge resolves a read's file name against it too; the two differ only by a project change
//   made while the turn runs. A skill read whose version is no longer stored is recorded in the ledger without
//   its text (its SHA-256 still scrubs it from later turns), and the next revocation check stops the turn anyway.
// - the skill ledger: one per process (index.cjs), shared with chat.cjs, so a version a native turn recorded is
//   scrubbed from the next turn whichever executor runs it.
const crypto = require('node:crypto');
const { trustedFront } = require('./trusted-front.cjs');

const HANDOFF_HEADER = 'x-noevia-chat-handoff';
const CAPS_HEADER = 'x-noevia-chat-handoff-caps';
const PREPARED_VERSION = 1;
const EXECUTE_PATH = '/internal/chat/tools/execute';
const TARGET_PATH = '/internal/chat/tools/target';
const ABORT_PATH = '/internal/chat/tools/abort';
const EDIT_TARGET_PATH = '/internal/chat/tools/edit-target';
const GRANT_PATH = '/internal/chat/tools/grant';
const REVOKE_PATH = '/internal/chat/tools/revoke';
const DIGEST = /^[0-9a-f]{64}$/;
const GRANT_HANDLE = /^[0-9a-f]{32}$/;
// A grant handle's life, and how many may wait to be redeemed (per account and in all).
const GRANT_HANDLE_TTL_MS = 5 * 60 * 1000;
const GRANT_HANDLES_PER_USER = 64;
const GRANT_HANDLES_MAX = 1024;
// A grant scope (chat.cjs writeGrantScope) and an exchange key.
const SCOPE_CAP = 200;
const USAGE_PATH = '/internal/chat/usage';
const PREFILL_PATH = '/internal/chat/prefill';
const NATIVE_PREFIX = '/internal/chat/native/';
const NATIVE_OPS = new Set(['health', 'load', 'tools-allowed', 'tools-unsupported', 'busy', 'title-auto-named', 'title-save', 'tool-used', 'supervise']);
const SKILLS_PREFIX = '/internal/chat/skills/';
const SKILL_OPS = new Set(['revoked', 'read', 'scrub']);
const SHA256 = /^[a-f0-9]{64}$/;
// A skill's stored file name and its name (instruction-skills.cjs keeps names to 160; a file name is a storage path).
const SKILL_FILE_CAP = 4096;
const SKILL_LIST_CAP = 2000;
const MESSAGE_LIST_CAP = 100000;
const BODY_CAP = 16 * 1024 * 1024;
// POST /api/chat's body cap (index.cjs STORED_HISTORY_BYTES, rust-chat-turn.cjs): a chat's first message fits in it.
const CHAT_BODY_CAP = 32 * 1024 * 1024;
const USER_CAP = 200;
// A tool name the front counts (usage.cjs keeps 80 characters of it).
const TOOL_NAME_CAP = 200;
// A chat id (and the chat key a tool call names, chatId || spaceId): chat.cjs sets no length of its own.
const CHAT_ID_CAP = 400;
const MODEL_CAP = 400;
// The front's X-Noevia-Lease value: the gate's token (32 hex today), kept to a short header-safe token.
const LEASE_TOKEN = /^[A-Za-z0-9._~-]{1,200}$/;
const LEASE_HEADER = 'X-Noevia-Lease';

/**
 * `requested(req)`: whether the front asked for this turn's hand-off: a turn relayed by the front
 * (rust-chat-turn.cjs relayedUser) carrying the header with the per-start secret. The header is removed either way,
 * and so is the capabilities header. `capabilities(req)`: the tokens that header named (a Set), read by
 * `requested` and only for a request it accepted; empty otherwise.
 */
function createHandoff({ secret, supervising = () => false, relayed = (req) => require('./rust-chat-turn.cjs').relayedUser(req) }) {
  const want = Buffer.from(String(secret || ''), 'utf8');
  const caps = new WeakMap();
  function requested(req) {
    const raw = req?.headers?.[HANDOFF_HEADER];
    const named = req?.headers?.[CAPS_HEADER];
    if (req?.headers) { delete req.headers[HANDOFF_HEADER]; delete req.headers[CAPS_HEADER]; }
    if (typeof raw !== 'string' || !want.length || !relayed(req)) return false;
    const got = Buffer.from(raw, 'utf8');
    const ok = got.length === want.length && crypto.timingSafeEqual(got, want);
    if (ok && typeof named === 'string' && named.length <= 1000) caps.set(req, new Set(named.split(',').map((t) => t.trim()).filter(Boolean)));
    return ok;
  }
  const capabilities = (req) => (req && typeof req === 'object' && caps.get(req)) || new Set();
  return { requested, capabilities, supervising: () => { try { return supervising() === true; } catch { return true; } } };
}

/** A message content the executor carries as it is: a list of text parts and image parts (image_url with a url). */
function wireParts(content) {
  return Array.isArray(content) && content.every((p) => p && typeof p === 'object' && !Array.isArray(p)
    && ((p.type === 'text' && typeof p.text === 'string')
      || (p.type === 'image_url' && p.image_url && typeof p.image_url === 'object' && typeof p.image_url.url === 'string')));
}

/**
 * Why the native executor cannot run this turn yet, or null when it can. Every condition is a part of chat.cjs
 * the executor does not do yet; each is lifted when it does. Read at the end of the preparation, so it sees the
 * route, the model and the tools as they were settled.
 */
function refusal(t) {
  for (const check of REFUSALS) { const why = check(t); if (why) return why; }
  return null;
}

/**
 * Every reason refusal() would name for this turn, in its order (the first is refusal()'s), so the log can say what
 * else keeps a turn here once the first is lifted (track R15). Only for that log: a check that throws is skipped.
 */
function refusals(t) {
  const out = [];
  for (const check of REFUSALS) { try { const why = check(t); if (why) out.push(why); } catch { /* the log only */ } }
  return out;
}

const REFUSALS = [
  // A chat id that is not text (a hand-made request): chat.cjs's permission checks throw on it, which the
  // native gate does not reproduce, so the turn stays here.
  (t) => (t.chatIdNotText ? 'chat-id' : null),
  (t) => (t.deleted ? 'deleted' : null),
  (t) => (t.diary ? 'diary' : null),
  (t) => (t.providerId !== t.defaultProviderId || t.machine || t.external || t.chatgpt || t.routeTarget ? 'provider' : null),
  (t) => (t.authorized ? 'provider-key' : null),
  // #1726's retrieved images (multimodal RAG: their notes, captions and parts) are not the executor's yet. A project's
  // attached images are: they ride on the last user message as image parts (chat.cjs's vision step), which the
  // executor carries, measures (context-fit counts each image_url) and sends as they are.
  (t) => (t.retrievedImages ? 'retrieved-images' : null),
  (t) => (!t.messages.every((m) => typeof m?.content === 'string' || wireParts(m?.content)) ? 'images' : null),
  // A project with instruction skills, for a front that does not say it runs their checks (CAPS_HEADER).
  (t) => (t.skills ? 'skills' : null),
  (t) => (t.provenance ? 'provenance' : null),
  (t) => (t.framingReasoner ? 'framing-reasoner' : null),
  (t) => (t.narrowed ? 'narrowed-tools' : null),
  (t) => (t.gate ? 'tool-gate' : null),
  (t) => (t.supervision ? 'step-supervision' : null),
  // An injected whole file whose name is not text (retrieval never makes one): its attribution keys on the value.
  (t) => (t.injected ? 'injected-sources' : null),
  // The coworker page save (#2446): asked about every time, never under a chat-wide grant; for a front that does not
  // say it runs that card (CAPS_HEADER `once`). The project edit tools (#648) are the executor's: the prepared frame
  // names them (`editTools`).
  (t) => (t.pageSave ? 'page-save' : null),
  (t) => (t.streamGuard ? 'stream-guard' : null),
];

/**
 * #1793's attribution after the reply (chat.cjs's close: chat-sources.cjs usedInjected, then buildSources), with
 * everything that does not depend on the answer done here: `reply` the sources the reply already showed
 * (buildSources(placed, readable)); `injected` the injected whole files not among the placed ones, in prompt
 * order, each with the part of its text the attribution reads (marks: the first ATTRIBUTE_MAX units of
 * String(body || '')) and the source item buildSources would add for it, or null when its file is not readable.
 * The executor keeps the rest: which of them the answer drew on, then reply + their items, at most MAX_SOURCES.
 */
function injectedSources({ injected, placed, readable, reply }) {
  const sources = require('./chat-sources.cjs');
  const placedList = Array.isArray(placed) ? placed : [];
  const already = new Set(placedList.map((e) => e && e.file));
  const out = [];
  for (const e of Array.isArray(injected) ? injected : []) {
    if (!e || e.kind !== 'file' || already.has(e.file)) continue;
    out.push({ file: e.file, text: String(e.body || '').slice(0, sources.ATTRIBUTE_MAX), item: sources.buildSources([e], readable)[0] || null });
  }
  return { reply: Array.isArray(reply) ? reply : [], injected: out };
}

// js-json's wtf16 (the frame reader) holds a lone surrogate as a character of U+10F800..U+10FFFF, so it refuses
// those characters themselves: a frame carrying one would fail the hand-off after this process let the turn go.
// In UTF-16 they are U+DBFE or U+DBFF followed by a low surrogate (JSON.stringify writes them raw).
const RESERVED = /[\udbfe\udbff][\udc00-\udfff]/;
/** Whether the prepared frame's JSON text holds a character the native executor cannot read (the turn stays here). */
function reservedText(json) {
  return typeof json !== 'string' || RESERVED.test(json);
}
// The longest `prepared` line the front reads (noevia-rs crates/chat-turn handoff.rs PREPARED_CAP); a longer one
// would fail the turn after this process let it go. Attached images are what can make it that long: their bytes are
// not bounded by the chat body's cap.
const PREPARED_CAP = 40 * 1024 * 1024;
/** Whether the prepared frame's JSON text is longer than the front reads (the turn stays here). */
function frameTooLarge(json) {
  return typeof json !== 'string' || Buffer.byteLength(json, 'utf8') > PREPARED_CAP;
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
    // The offered tools that are noevia's own project file edits (chat.cjs projectEditTool): resolved through the
    // edit-target bridge before their card, and pinned to that file.
    editTools: Array.isArray(t.editTools) ? t.editTools : [],
    // #2446: the offered tools asked about on every call and never under a chat-wide grant (the coworker page save).
    // Only present when there are any, so a frame without them is the one the earlier executors read.
    ...(Array.isArray(t.onceTools) && t.onceTools.length ? { onceTools: t.onceTools } : {}),
    // #769 (track R15): the provenance policy is on for this turn (provenance-policy.cjs; a flag read that threw counts
    // as on): the executor takes each round's untrusted text in and checks every write's arguments against it. Only
    // present when on, and only for a front naming the `provenance` capability (else the turn stays here).
    ...(t.provenance === true ? { provenance: true } : {}),
    // Step supervision is on (features.stepSupervision, R15): after a tool round the executor asks the supervise
    // bridge as chat.cjs asks superviseNextStep. Only present when on, and only for a front naming `supervise`.
    ...(t.supervise === true ? { supervise: true } : {}),
    // Roadmap E (R15): what more_tools widens to, on a turn whose routed list was narrowed (absent otherwise): the
    // tools, their MCP routes, and which of them are writes, public, project edits or once-only, as for `tools`.
    ...(t.widen && typeof t.widen === 'object' ? { widen: {
      tools: t.widen.tools, routes: t.widen.routes, writes: t.widen.writes, public: t.widen.public,
      editTools: t.widen.editTools, onceTools: t.widen.onceTools,
      // [name, write, blocked]: the policy reads the resolution made (chat.cjs `blocked`), in order; the executor
      // makes the same reads when it widens.
      asked: t.widen.asked } } : {}),
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
      // The Compact action: the context fit is forced, then the turn ends with `done` (no round, no title).
      compactOnly: t.compactOnly === true,
      sources: t.sources || { reply: [], injected: [] },
    },
    // A project turn's instruction skills (#272/#546), null without a project: `loaded` the skills the prompt carries
    // (pinned or picked automatically), `enabled` the snapshot's enabled skills a tool call may still load, in list
    // order; `revokedInHistory` the names already taken out of the history, and the reply warning's other parts.
    skills: t.skills ? {
      loaded: t.skills.loaded, enabled: t.skills.enabled, revokedInHistory: t.skills.revokedInHistory,
      imageWarning: t.skills.imageWarning || '', coverageWarning: t.skills.coverageWarning || '',
    } : null,
  };
}

/**
 * index.cjs chatNativeAsUser: `fn` runs as `userId` only for an account that exists, is not disabled and whose
 * workspace stands; otherwise it throws a 404 "no such account". `userRow(id)` is the users row ({disabled_at}) or
 * nothing, `runAs(id, fn)` index.cjs diaryAsUser (workspaceStore.get, which throws 410 for a removed account or a
 * folder that is gone, then the request scope). A 410 from the workspace lookup is that same refusal; one thrown by
 * `fn` itself (a tool's own answer) is left as it is.
 */
function createAsUser({ userRow, runAs, currentWorkspace }) {
  const gone = () => Object.assign(Error('no such account'), { status: 404 });
  return (userId, fn) => {
    const row = userRow(userId);
    if (!row || row.disabled_at) throw gone();
    let entered = false;
    try {
      return runAs(userId, () => {
        entered = true;
        if (currentWorkspace().revoked) throw gone();
        return fn();
      });
    } catch (error) {
      if (!entered && error?.status === 410) throw gone();
      throw error;
    }
  };
}

/**
 * The bridges. `asUser(userId, fn)` runs fn in that user's request scope (createAsUser above), where `currentUser()`
 * is the signed-in user chat.cjs passes as `chatUser` and `currentWorkspace()` theirs.
 */
function createToolBridge({ secret, json, readJson, asUser, getProject, executeToolCall, writeTargetFor, recordToolUse, currentWorkspace, currentUser,
  editStorageAccount = () => null, recordUsage = () => {}, recordSample = () => {}, modelManager = null, templateToolsGate = null, chatTitles = null, chatBodyCap = CHAT_BODY_CAP,
  skillLedger = null, chatWideApproved = null, redeemChatGrant = null, revokeChatGrant = null, stepSupervision = null, now = () => Date.now(),
  log = (line) => console.warn(line) }) {
  // Execute calls in progress by `${user}\u0000${exchangeKey}`: the abort bridge aborts their signals.
  const running = new Map();
  // The grant bridge's handles: handle -> {user, chat, scope, exchangeKey, grant, expires}, where `grant` is the
  // registry's frozen {ticket, epoch} (chatWideApproved). Each is taken out by the first execute call naming it.
  const grants = new Map();
  const callerGone = (req, res, controller = new AbortController()) => {
    const gone = () => { if (!res.writableEnded) controller.abort(); };
    req.once('close', () => { if (req.destroyed && !req.complete) gone(); });
    res.once('close', gone);
    return controller.signal;
  };
  const text = (v, cap) => (typeof v === 'string' && v.length <= cap ? v : null);
  // A model name keys the tools gate's cache (`scope\u0000model`) and the usage and prefill records: no control
  // characters (U+0000-U+001F, U+007F).
  const control = (v) => { for (let i = 0; i < v.length; i += 1) { const c = v.charCodeAt(i); if (c < 0x20 || c === 0x7f) return true; } return false; };
  const modelName = (v) => (typeof v === 'string' && v.length > 0 && v.length <= MODEL_CAP && !control(v) ? v : null);
  const names = (v) => (Array.isArray(v) && v.length <= 2000 && v.every((n) => typeof n === 'string' && n.length <= 200) ? v : null);
  const missing = (error) => error?.status === 404;
  const instructionSkills = () => require('./instruction-skills.cjs');
  const noContent = (res) => { res.statusCode = 204; res.end(); };
  const noAccount = (res) => json(res, 404, { error: 'no such account' });
  const plain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  // A grant's chat, scope and binding (the chat's permission context, chat-grant-context.cjs), or null.
  const grantFields = (v) => {
    const chat = text(v?.chat, CHAT_ID_CAP), scope = text(v?.scope, SCOPE_CAP);
    return chat && scope && plain(v?.binding) ? { chat, scope, binding: v.binding } : null;
  };
  // Whether one more handle fits for `user`, after the expired ones are gone. A live handle is never evicted.
  function grantRoom(user) {
    const t = now();
    for (const [h, e] of grants) if (!(e.expires > t)) grants.delete(h);
    if (grants.size >= GRANT_HANDLES_MAX) return false;
    let mine = 0;
    for (const e of grants.values()) if (e.user === user && (mine += 1) >= GRANT_HANDLES_PER_USER) return false;
    return true;
  }
  // The signed-in workspace is this user's and stands (chat.cjs's check before a grant is used).
  const ownWorkspace = (user) => { try { const ws = currentWorkspace(); return !!ws && ws.userId === user && !ws.revoked; } catch { return false; } };
  // The grant bridge, as the user: a handle for the registry's ticket, or null (no grant: the card asks).
  async function grantHandle(user, chat, scope, binding, exchangeKey) {
    // Without redeemChatGrant a handle is still handed out, but its execute call answers 'unavailable' (never unfenced).
    if (typeof chatWideApproved !== 'function' || !ownWorkspace(user) || !grantRoom(user)) return null;
    const grant = await chatWideApproved(user, chat, scope, binding);
    if (!grant || typeof grant !== 'object' || typeof grant.ticket !== 'string' || !grant.ticket) return null;
    // Asked again: other grant checks may have filled the room while the front answered.
    if (!grantRoom(user)) return null;
    const handle = crypto.randomBytes(16).toString('hex');
    grants.set(handle, { user, chat, scope, exchangeKey, grant, expires: now() + GRANT_HANDLE_TTL_MS });
    return handle;
  }
  // Every fact runs as the relayed user, so an account that is gone, disabled or revoked reads nothing (404).
  async function nativeFact(op, body, req, res) {
    const who = text(body?.user, USER_CAP);
    if (!who) return json(res, 400, { error: 'user is required.' });
    return asUser(who, () => fact(op, who, body, req, res));
  }
  async function fact(op, who, body, req, res) {
    const model = modelName(body?.model);
    const needModel = () => { if (!model) { json(res, 400, { error: 'model is required.' }); return true; } return false; };
    const managerOff = () => { if (!modelManager?.enabled) { json(res, 409, { enabled: false }); return true; } return false; };
    if (op === 'health') {
      if (managerOff()) return;
      const r = await modelManager.health();
      return json(res, 200, { ok: r?.ok === true, body: r?.ok ? r.body ?? null : null });
    }
    if (op === 'load') {
      if (needModel()) return;
      const token = body?.lease;
      if (token !== null && !(typeof token === 'string' && LEASE_TOKEN.test(token))) return json(res, 400, { error: 'lease is required (the X-Noevia-Lease value, or null).' });
      if (managerOff()) return;
      // The shape chat.cjs passes (the gate client's lease): what the load's requests carry. With none, chat.cjs's
      // own load without a lease (chat-context.cjs resolveManagedLimit).
      const lease = token === null ? null : { headers: () => ({ [LEASE_HEADER]: token }) };
      const signal = callerGone(req, res);
      const r = lease ? await modelManager.load(model, {}, signal, { lease }) : await modelManager.load(model, {}, signal);
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
    if (op === 'tool-used') {
      const name = text(body?.name, TOOL_NAME_CAP);
      if (!name) return json(res, 400, { error: 'name is required.' });
      recordToolUse(currentWorkspace(), name);
      return noContent(res);
    }
    if (op === 'supervise') {
      // chat.cjs's step supervision after a tool round (step-supervision.cjs superviseNextStep), for a native turn:
      // `outputs` the round's last tool and assistant messages as the supervisor reads them ({role, content}: at
      // most 8, each at most 1500 units), `goal` the turn's message, `wrote` whether a write was about to run in
      // the round, `goal` the turn's message as the supervisor reads it (its first 1500 units). Answers the
      // supervisor's action: continue, verify (the executor adds the check note) or escalate (the executor pauses
      // the reply). Its log and the decision service stay here.
      const round = Number.isSafeInteger(body?.round) && body.round >= 0 && body.round <= 3 ? body.round : null;
      const goal = text(body?.goal, 1500);
      const outputs = Array.isArray(body?.outputs) && body.outputs.length <= 8 && body.outputs.every((m) => plain(m)
        && (m.role === 'tool' || m.role === 'assistant') && text(m.content, 1500) !== null) ? body.outputs.map((m) => ({ role: m.role, content: m.content })) : null;
      if (round === null || goal === null || !outputs || typeof body?.wrote !== 'boolean') return json(res, 400, { error: 'round, goal, outputs and wrote are required.' });
      const signal = callerGone(req, res);
      const r = await require('./step-supervision.cjs').superviseNextStep(stepSupervision, { round, messages: outputs, signal, goal, wrote: body.wrote });
      return json(res, 200, { action: r.pause ? 'escalate' : r.decision?.action === 'verify' ? 'verify' : 'continue' });
    }
    if (op === 'busy') {
      let busy = false;
      const own = Number.isSafeInteger(body?.own) && body.own >= 1 && body.own <= 8 ? body.own : 1;
      try { busy = typeof modelManager?.inferenceBusy === 'function' && modelManager.inferenceBusy(own) === true; } catch { busy = false; }
      return json(res, 200, { busy });
    }
    const chat = text(body?.chatId, CHAT_ID_CAP), first = text(body?.firstMessage, chatBodyCap);
    const list = body?.listId === null || body?.listId === undefined ? null : text(body.listId, 400);
    if (!who || !chat || first === null || (body?.listId != null && !list)) return json(res, 400, { error: 'user, chatId and firstMessage are required.' });
    if (op === 'title-auto-named') {
      let autoNamed = false;
      try { autoNamed = chatTitles.autoNamed(list, chat, first) === true; } catch { autoNamed = false; }
      return json(res, 200, { autoNamed });
    }
    const title = text(body?.title, 400);
    if (!title) return json(res, 400, { error: 'title is required.' });
    try { chatTitles.save(list, chat, title, first); } catch { /* the client saves it too */ }
    return noContent(res);
  }
  // The skill bridges: a list of {file, hash, name} as the prepared frame carries them, or null.
  const skillList = (v) => (Array.isArray(v) && v.length <= SKILL_LIST_CAP && v.every((k) => k && typeof k === 'object' && !Array.isArray(k)
    && text(k.file, SKILL_FILE_CAP) && typeof k.hash === 'string' && SHA256.test(k.hash) && text(k.name, SKILL_FILE_CAP) !== null) ? v.map((k) => ({ file: k.file, hash: k.hash, name: k.name })) : null);
  const pick = (k) => ({ file: k.file, hash: k.hash, name: k.name });
  function skillOp(op, who, body, res) {
    const projectId = text(body?.projectId, 200);
    if (!projectId) return json(res, 400, { error: 'projectId is required.' });
    const chatId = body?.chatId === undefined || body?.chatId === null ? null : text(body.chatId, CHAT_ID_CAP);
    if (op !== 'revoked' && chatId === null && body?.chatId != null) return json(res, 400, { error: 'chatId is invalid.' });
    if (op === 'revoked') {
      const loaded = skillList(body?.loaded);
      if (!loaded) return json(res, 400, { error: 'loaded is required.' });
      // chat.cjs revokedSkills: the loaded skills against the project as stored now.
      const gone = instructionSkills().revoked(getProject(projectId), new Map(loaded.map((k) => [k.file, { hash: k.hash, name: k.name }])));
      return json(res, 200, { gone: gone.map((g) => ({ file: g.file, name: g.name })) });
    }
    const workspace = currentWorkspace();
    const dir = workspace?.dir || null;
    const assertActive = () => workspace?.assertActive?.();
    if (op === 'read') {
      const candidates = skillList(body?.candidates), args = text(body?.args, chatBodyCap), result = text(body?.result, chatBodyCap);
      if (!candidates || args === null || result === null) return json(res, 400, { error: 'candidates, args and result are required.' });
      const project = getProject(projectId);
      const matched = require('./skill-reads.cjs').matchedReads(project, candidates, args, result);
      // chat.cjs rememberSkill, with the version's text as stored now (the turn's snapshot is chat.cjs's own).
      const stored = matched.length && project ? instructionSkills().list(project) : [];
      for (const k of matched) {
        const content = stored.find((s) => s.file === k.file && s.hash === k.hash)?.content || '';
        if (dir && skillLedger) skillLedger.record(dir, project || { id: projectId, files: [] }, { file: k.file, hash: k.hash, name: k.name, content }, { chatId, assertActive });
      }
      return json(res, 200, { loaded: matched.map(pick) });
    }
    const raw = body?.messages;
    const messages = Array.isArray(raw) && raw.length <= MESSAGE_LIST_CAP && raw.every((m) => m === null || (m && typeof m === 'object' && !Array.isArray(m)
      && text(m.role, 40) && typeof m.content === 'string')) ? raw.map((m) => (m ? { role: m.role, content: m.content } : null)) : null;
    if (!messages) return json(res, 400, { error: 'messages is required.' });
    // chat.cjs before its first round: against the project as stored now, when it still exists.
    const current = getProject(projectId);
    const scrubbed = current && dir && skillLedger ? skillLedger.scrub({ dir, project: current, messages, chatId }) : null;
    const changed = [];
    if (scrubbed?.removed.length) scrubbed.messages.forEach((m, i) => { if (m !== messages[i]) changed.push([i, m.content]); });
    return json(res, 200, { changed, removed: scrubbed?.removed.length ? scrubbed.removed : [] });
  }
  return async function handle(req, res) {
    const path = String(req.url || '').split('?')[0];
    const op = path.startsWith(NATIVE_PREFIX) ? path.slice(NATIVE_PREFIX.length) : null;
    const skill = path.startsWith(SKILLS_PREFIX) && SKILL_OPS.has(path.slice(SKILLS_PREFIX.length)) ? path.slice(SKILLS_PREFIX.length) : null;
    if (path !== EXECUTE_PATH && path !== TARGET_PATH && path !== ABORT_PATH && path !== EDIT_TARGET_PATH && path !== GRANT_PATH && path !== REVOKE_PATH
      && path !== USAGE_PATH && path !== PREFILL_PATH && !NATIVE_OPS.has(op) && !skill) return false;
    if (!trustedFront(req, secret) || req.method !== 'POST') { json(res, 404, { error: 'Not found' }); return true; }
    let body;
    // A title bridge carries the chat's first message, which may be as long as a chat request; a skill read its tool
    // result and a scrub the turn's messages.
    const cap = op === 'title-auto-named' || op === 'title-save' || skill === 'read' || skill === 'scrub' ? Math.max(BODY_CAP, chatBodyCap + 1024 * 1024) : BODY_CAP;
    try { body = await readJson(req, cap); } catch { json(res, 400, { error: 'invalid JSON' }); return true; }
    const count = (v) => (v === null || (Number.isSafeInteger(v) && v >= 0) ? v : undefined);
    if (skill) {
      const who = text(body?.user, USER_CAP);
      if (!who) { json(res, 400, { error: 'user is required.' }); return true; }
      try { await asUser(who, async () => skillOp(skill, who, body, res)); }
      catch (error) {
        if (missing(error)) { noAccount(res); return true; }
        // The detail can name a stored path: logged here, never sent.
        log(`[chat] native skills ${skill} bridge failed: ${String(error?.message || error).slice(0, 300)}`);
        json(res, 500, { error: 'the skills could not be checked' });
      }
      return true;
    }
    if (op) {
      try { await nativeFact(op, body, req, res); }
      catch (error) {
        if (missing(error)) { noAccount(res); return true; }
        // The detail can name the manager's address or a fetch failure: logged here, never sent.
        log(`[chat] native ${op} bridge failed: ${String(error?.message || error).slice(0, 300)}`);
        json(res, 500, { error: 'the fact could not be read' });
      }
      return true;
    }
    if (path === ABORT_PATH) {
      const who = text(body?.user, USER_CAP), key = text(body?.exchangeKey, 200);
      if (!who || !key) { json(res, 400, { error: 'user and exchangeKey are required.' }); return true; }
      for (const controller of running.get(`${who}\u0000${key}`) || []) controller.abort();
      noContent(res); return true;
    }
    if (path === GRANT_PATH || path === REVOKE_PATH) {
      const who = text(body?.user, USER_CAP), chat = text(body?.chat, CHAT_ID_CAP);
      if (!who || !chat) { json(res, 400, { error: 'user and chat are required.' }); return true; }
      if (path === REVOKE_PATH) {
        if (typeof revokeChatGrant !== 'function') { json(res, 503, { error: 'chat-wide grants are not available' }); return true; }
        try {
          const revoked = await asUser(who, async () => (await revokeChatGrant(who, chat)) === true);
          json(res, 200, { revoked });
        } catch (error) {
          if (missing(error)) { noAccount(res); return true; }
          log(`[chat] native grant revoke bridge failed: ${String(error?.message || error).slice(0, 300)}`);
          json(res, 500, { error: 'the grant could not be revoked' });
        }
        return true;
      }
      const fields = grantFields(body), exchangeKey = text(body?.exchangeKey, 200);
      if (!fields || !exchangeKey) { json(res, 400, { error: 'scope, binding and exchangeKey are required.' }); return true; }
      try {
        const handle = await asUser(who, () => grantHandle(who, fields.chat, fields.scope, fields.binding, exchangeKey));
        json(res, 200, handle ? { granted: true, handle } : { granted: false });
      } catch (error) {
        if (missing(error)) { noAccount(res); return true; }
        log(`[chat] native grant bridge failed: ${String(error?.message || error).slice(0, 300)}`);
        json(res, 500, { error: 'the grant could not be checked' });
      }
      return true;
    }
    if (path === PREFILL_PATH) {
      const who = text(body?.user, USER_CAP), model = modelName(body?.model), prompt = body?.promptTokens, ms = body?.firstTokenMs;
      if (!who || !model || !Number.isSafeInteger(prompt) || prompt <= 0 || !Number.isFinite(ms) || ms <= 0) { json(res, 400, { error: 'user, model, promptTokens and firstTokenMs are required.' }); return true; }
      try { await asUser(who, async () => recordSample(model, prompt, ms)); }
      catch (error) {
        if (missing(error)) { noAccount(res); return true; }
        log(`[chat] native prefill bridge failed: ${String(error?.message || error).slice(0, 300)}`);
        json(res, 500, { error: 'prefill not recorded' }); return true;
      }
      noContent(res); return true;
    }
    if (path === USAGE_PATH) {
      const who = text(body?.user, USER_CAP), model = modelName(body?.model), r = body?.reported;
      const reported = r && typeof r === 'object' && !Array.isArray(r)
        ? { promptTokens: count(r.promptTokens), completionTokens: count(r.completionTokens), totalTokens: count(r.totalTokens),
          tokensPerSecond: r.tokensPerSecond === null || (Number.isFinite(r.tokensPerSecond) && r.tokensPerSecond > 0) ? r.tokensPerSecond : undefined } : null;
      if (!who || !model || !reported || Object.values(reported).some((v) => v === undefined)) { json(res, 400, { error: 'user, model and reported are required.' }); return true; }
      try { await asUser(who, async () => recordUsage(currentWorkspace(), model, reported)); }
      catch (error) {
        if (missing(error)) { noAccount(res); return true; }
        log(`[chat] native usage bridge failed: ${String(error?.message || error).slice(0, 300)}`);
        json(res, 500, { error: 'usage not recorded' }); return true;
      }
      noContent(res); return true;
    }
    const user = text(body?.user, USER_CAP);
    const name = text(body?.name, 200);
    const args = text(body?.args, BODY_CAP);
    if (!user || !name || args === null) { json(res, 400, { error: 'user, name and args are required.' }); return true; }
    if (path === EDIT_TARGET_PATH) {
      const edits = require('./project-edit-target.cjs');
      const projectId = body.projectId === undefined || body.projectId === null ? null : text(body.projectId, 200);
      if ((projectId === null && body.projectId != null) || projectId === '' || !edits.EDIT_TOOLS.has(name)) { json(res, 400, { error: 'projectId or name is invalid.' }); return true; }
      let found;
      try {
        // chat.cjs: resolveEditTarget(project ? getProject(project.id) : null, tc.args, { storageAccount: editStorageAccount(userId) }),
        // as the user (their workspace's project and storage connection).
        found = await asUser(user, async () => edits.resolveEditTarget(projectId ? getProject(projectId) : null, args, { storageAccount: editStorageAccount(user) }));
      } catch (error) {
        if (missing(error)) { noAccount(res); return true; }
        log(`[chat] native edit-target bridge failed: ${String(error?.message || error).slice(0, 300)}`);
        found = { error: 'The file this would change could not be looked up' };
      }
      if (found?.error) json(res, 200, { error: String(found.error) });
      else json(res, 200, { path: found.path, account: found.account || null, digest: edits.targetDigest(found.path, found.account || null) });
      return true;
    }
    const chatKey = body.chatKey === undefined || body.chatKey === null ? null : text(body.chatKey, CHAT_ID_CAP);
    if (chatKey === null && body.chatKey !== undefined && body.chatKey !== null) { json(res, 400, { error: 'chatKey is invalid.' }); return true; }
    try {
      if (path === TARGET_PATH) {
        let found;
        try { found = await asUser(user, async () => (typeof writeTargetFor === 'function' ? writeTargetFor(name, args, { user: currentUser(), chatKey }) : null)); }
        catch (error) {
          if (missing(error)) { noAccount(res); return true; }
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
      const editTarget = body.editTarget === undefined || body.editTarget === null ? null : body.editTarget;
      if ((body.projectId && !projectId) || (body.exchangeKey && !exchangeKey) || (editTarget !== null && !(typeof editTarget === 'string' && DIGEST.test(editTarget)))) {
        json(res, 400, { error: 'projectId, exchangeKey or editTarget is invalid.' }); return true;
      }
      let asked = null;
      if (body.grant !== undefined && body.grant !== null) {
        const g = body.grant;
        const fields = plain(g) && typeof g.handle === 'string' && GRANT_HANDLE.test(g.handle) ? grantFields(g) : null;
        if (!fields || !exchangeKey) { json(res, 400, { error: 'grant is invalid (handle, chat, scope and binding, with an exchangeKey).' }); return true; }
        asked = { handle: g.handle, ...fields };
      }
      // A grant handle is single use: taken out before anything else, whatever happens next. One that is unknown,
      // expired or not this call's (user, chat, scope, exchange) never runs the call.
      let entry = null;
      if (asked) {
        entry = grants.get(asked.handle) || null;
        grants.delete(asked.handle);
        if (!entry || !(entry.expires > now()) || entry.user !== user || entry.chat !== asked.chat || entry.scope !== asked.scope || entry.exchangeKey !== exchangeKey) {
          json(res, 200, { redeem: 'refused' }); return true;
        }
        // #2446: a once-only tool (the coworker page save) never runs under a chat-wide grant, whatever the caller sends.
        if (require('./specialist-page-save.cjs').neverStanding(name)) { json(res, 200, { redeem: 'refused' }); return true; }
        // A grant is never run unfenced.
        if (typeof redeemChatGrant !== 'function') { json(res, 200, { redeem: 'unavailable' }); return true; }
      }
      const controller = new AbortController();
      const signal = callerGone(req, res, controller);
      const runKey = exchangeKey ? `${user}\u0000${exchangeKey}` : null;
      if (runKey) { if (!running.has(runKey)) running.set(runKey, new Set()); running.get(runKey).add(controller); }
      let ran;
      try {
        ran = await asUser(user, async () => {
          const project = projectId ? getProject(projectId) : null;
          if (projectId && !project) return null;
          let fence = null;
          if (entry) {
            // chat.cjs: redeemed at the front after the final checks, with the call's final binding; the fence is
            // carried to the executor's outbound write.
            if (!ownWorkspace(user)) return { redeem: 'refused' };
            const redeemed = await redeemChatGrant(user, entry.chat, entry.scope, asked.binding, entry.grant);
            if (redeemed === 'unavailable') return { redeem: 'unavailable' };
            if (!redeemed || typeof redeemed !== 'object' || typeof redeemed.open !== 'function' || typeof redeemed.started !== 'function') return { redeem: 'refused' };
            fence = redeemed;
            // chat.cjs: an exchange stopped while the front redeemed (the abort bridge, or the caller gone) runs nothing.
            if (signal.aborted) { fence.started(); return { redeem: 'aborted' }; }
            // chat.cjs's early refusal (notChecked): the answer came too late to act on.
            if (!fence.open()) { fence.started(); return { redeem: 'unavailable' }; }
          }
          const outcome = { failed: false };
          let out;
          try {
            out = await executeToolCall(project, name, args, allowed, signal, outcome,
              { chatKey, exchangeKey, routes, ...(editTarget !== null ? { editTarget } : {}), ...(fence ? { writeFence: fence } : {}) });
          } finally { fence?.started(); }
          const reply = { text: String(out ?? ''), failed: outcome.failed === true };
          // Refused at its outbound write (a closed fence): not run, so not counted (chat.cjs).
          if (outcome.notRun === true) return { ...reply, notRun: true };
          recordToolUse(currentWorkspace(), name);
          return reply;
        });
      } finally {
        const set = runKey && running.get(runKey);
        if (set) { set.delete(controller); if (!set.size) running.delete(runKey); }
      }
      if (!ran) { json(res, 404, { error: 'no such project' }); return true; }
      json(res, 200, ran);
    } catch (error) {
      if (missing(error)) { noAccount(res); return true; }
      // tool-exchange.cjs callError: the executor makes this the call's result.
      json(res, 500, { error: String(error?.message || 'the tool bridge failed').slice(0, 300) });
    }
    return true;
  };
}

module.exports = { HANDOFF_HEADER, CAPS_HEADER, PREPARED_VERSION, EXECUTE_PATH, TARGET_PATH, ABORT_PATH, EDIT_TARGET_PATH, GRANT_PATH, REVOKE_PATH, GRANT_HANDLE_TTL_MS, USAGE_PATH, PREFILL_PATH, NATIVE_PREFIX, SKILLS_PREFIX, CHAT_BODY_CAP, PREPARED_CAP, createHandoff, refusal, refusals, reservedText, frameTooLarge, injectedSources, preparedTurn, createAsUser, createToolBridge };
