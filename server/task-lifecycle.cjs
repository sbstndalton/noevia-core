'use strict';
// Pure, deterministic task-lifecycle layer for the vision multi-agent pipeline (#511/#512).
// This module knows nothing about models, HTTP, or storage: it is a state machine plus a
// derivation function over the jobs.cjs journal event vocabulary (see jobs.cjs `TYPES`). It
// never changes job.cjs semantics — it only reads the same append-only events a job already
// writes (plus, since #701, the pipeline's own `task.stage`/`task.revision`, below) and infers a
// coarser, higher-level
// "where is this task in its life" state that the current job.status (queued/running/
// waiting_approval/completed/failed/cancelled/interrupted) does not express.
//
// Offline, no model calls, no UI. See docs/spec-agent-execution.md and the #511 fit-gap
// analysis: "lifecycle lacks planned/verifying/reviewing/changes_requested/merged/blocked".
//
// Honesty constraint (2026-09-28 review, #522): today's job kinds (chat, code, browser,
// research, source) have no real reviewer and no real merge step — `approval.requested` /
// `approval.decided` are the per-tool-call write-approval gate (a human clicking Allow/Decline
// on one command), not a task-level code review, and `job.completed` just means the harness
// finished, not that anyone reviewed or merged the result. The derivation below therefore
// NEVER reaches `reviewing`, `changes_requested` or `merged` from today's real event stream —
// it only reaches `planned`, `implementing`, `verifying` and `blocked`.
//
// This is unconditional, with no data-carried opt-in: an earlier version of this module let a
// caller mark an event `review: true` / `merged: true` in its `data` to reach those states.
// That was removed (2026-09-28, second #522 review round) because `data` on these events is
// not trustworthy: `approval.requested`'s payload is the approval card itself, which
// browser-service.cjs builds by spreading a page- or model-influenced `card` object
// (`{ ...card, jobId }`), and `job.completed`'s `result` similarly comes from whatever the
// harness or model reported. A spoofed `review`/`merged` key on either would have silently
// forged a lifecycle state no human ever actually granted — exactly the kind of thing the real
// write-approval gate (`docs/agent-brief.md` — "a security control, not decoration") exists to
// prevent. A data flag on an existing, model-reachable event can never be trusted to carry
// lifecycle authority.
//
// The full transition table below still defines `reviewing`, `changes_requested` and `merged`
// and the legal moves into and out of them, so `transition()`/`canTransition()` keep working
// standalone. A future real review/merge feature reaches them by adding its own dedicated,
// server-only journal event types — e.g. `review.requested`, `review.decided`, `task.merged` —
// to jobs.cjs's `TYPES` allowlist, appended only from trusted server code path(s) that a
// model or page content cannot reach (the way `approval.decided` itself can only be appended
// by the harness after a human actually answers, never by tool/model output). Until that
// exists, `reviewing`/`changes_requested`/`merged` are reachable only from tests exercising
// this module directly, by design.
//
// #701 adds exactly those dedicated events: `task.stage` {from,to,revision,reason[,reportHash]}
// and `task.revision` {n,headSha,planHash}. jobs.cjs refuses to append either one unless the
// caller presents the lifecycle capability token (a module-private Symbol only the pipeline
// claims), so no ACP session, approval payload or job result can write them. A journal that
// carries one is *authoritative*: its lifecycle is folded from `task.stage` alone (each through
// `transition()`), the implicit moves above (job.started, canonical progress, job.completed) are
// ignored, and only the run ending without the pipeline's say-so (failed, cancelled,
// interrupted) still forces `blocked`. A journal without one folds exactly as before.
//
// Rust is the policy authority (#1071). Opcode 6 supplies state/transition metadata and
// diagnostics; the original five operations remain unchanged for the final wire-size,
// serialization and representation checks. No JavaScript state table or policy fold remains.
const { canEnterReviewing } = require('./completeness-report.cjs');
const defaultLoader = () => require('./dav-parse-wasm.cjs');
const metadata = defaultLoader().taskLifecycleDiagnostic(0);
const STATES = Object.freeze([...metadata.states]);
const INITIAL_STATE = metadata.initial;
const TRANSITIONS = Object.freeze(Object.fromEntries(Object.entries(metadata.transitions).map(([k, v]) => [k, Object.freeze([...v])])));
const AUTHORITY_TYPES = Object.freeze(new Set(metadata.authorityTypes));
const MAX_STATE_UNITS = Math.max(...STATES.map((s) => s.length));
const isAuthoritative = (events) => (events || []).some((e) => e && AUTHORITY_TYPES.has(e.type));

class TaskLifecycleError extends Error {
  constructor(message, { from, to, code } = {}) {
    super(message);
    this.name = 'TaskLifecycleError';
    this.from = from;
    this.to = to;
    this.code = code;
    this.status = 409;
  }
}
const warnedPort = new Set();
function portWarn(event, reason) {
  const key = `${event}:${reason}`;
  if (warnedPort.has(key)) return;
  warnedPort.add(key);
  console.warn(`[task-lifecycle] ${event} (${reason}); the transition was refused`);
}
function askPort(ask) {
  try { return ask(); }
  catch (err) {
    portWarn('task_lifecycle.wasm_fault', String(err?.reason || 'unexpected').slice(0, 40));
    return null;
  }
}
function refused() {
  throw new TaskLifecycleError('Task lifecycle refused by the Rust port', { code: 'impl_refused' });
}
function mismatch(reason) {
  portWarn('task_lifecycle.impl_mismatch', reason);
  throw new TaskLifecycleError('Task lifecycle disagrees with the Rust port', { code: 'impl_mismatch' });
}
function confirmState(ask, state) {
  const port = askPort(ask);
  if (!port) return refused();
  if (port.state !== state) return mismatch(port.throws !== undefined ? 'throws' : 'state');
  return state;
}
// Type/size projections only. An object with toJSON must never become an accepted string
// state/hash. Unknown raw values remain available to the error formatter, unchanged.
const stateWire = (value) => typeof value === 'string' && value.length <= MAX_STATE_UNITS ? value : null;
const hashWire = (value) => typeof value === 'string' && value.length <= 64 ? value : null;
function policy(operation, args) {
  const reply = askPort(() => defaultLoader().taskLifecycleDiagnostic(operation, args));
  if (!reply) return refused();
  return reply;
}
function policyError(reply, context) {
  const d = reply.diagnostic, code = reply.throws;
  // Error formatting uses the data object already read by step; never re-read event.data.
  const data = context.data;
  let from = d.current === undefined ? context.from : d.current;
  let to = d.target === undefined ? context.to : d.target;
  if (code === 'unknown_state') {
    const label = d.site === 'event_to' ? 'to' : d.site;
    const value = d.site === 'event_to' ? context.to : label === 'fromState' ? context.fromState : context[label];
    throw new TaskLifecycleError(`Unknown task-lifecycle state: ${label} = ${JSON.stringify(value)}`, { [label]: value, code });
  }
  if (d.site === 'pair' || context.rawMovement) { from = context.from; to = context.to; }
  if (code === 'stale') {
    throw new TaskLifecycleError(`Stale task-lifecycle stage: recorded from ${JSON.stringify(data.from)} but the task is ${from}`,
      { from: data.from, to: data.to, code });
  }
  const message = code === 'illegal' ? `Illegal task-lifecycle transition: ${from} -> ${to}`
    : code === 'report_hash' ? 'Entering reviewing needs the hash of the completeness report that allowed it'
      : `A task is merged only from reviewing, not ${from}`;
  throw new TaskLifecycleError(message, { from, to, code });
}
function pair(operation, from, to) {
  const reply = policy(operation, [stateWire(from), stateWire(to)]);
  if (reply.throws !== undefined) policyError(reply, { from, to });
  return reply;
}
function canTransition(from, to, { wasmLoader = defaultLoader } = {}) {
  const answer = pair(1, from, to);
  if (!answer.allowed) return false;
  const port = askPort(() => wasmLoader().taskLifecycleCanTransition(from, to));
  if (port && port.allowed === true) return true;
  if (port) portWarn('task_lifecycle.impl_mismatch', port.throws !== undefined ? 'throws' : 'allowed');
  return false;
}
function transition(from, to, { wasmLoader = defaultLoader } = {}) {
  const answer = pair(2, from, to);
  return confirmState(() => wasmLoader().taskLifecycleTransition(from, to), answer.state);
}
function assertStageMove(from, to, { wasmLoader = defaultLoader } = {}) {
  const answer = pair(3, from, to);
  return confirmState(() => wasmLoader().taskLifecycleStageMove(from, to), answer.state);
}
// The same bounded host projection used by the previous implementation. It is also the final
// serialization/refusal boundary, after the first policy error has had its original precedence.
const FOLD_FIELDS = new Map([['task.stage', ['from', 'to', 'reportHash']], ['task.revision', []], ['job.started', []],
  ['progress', ['stage']], ['job.completed', []], ['job.failed', []], ['job.cancelled', []], ['job.interrupted', []]]);
function foldInput(events) {
  if (events === undefined || events === null) return null;
  if (!Array.isArray(events)) return events;
  const out = [];
  for (const event of events) {
    if (!event || typeof event.type !== 'string' || !FOLD_FIELDS.has(event.type)) continue;
    const fields = FOLD_FIELDS.get(event.type);
    if (!fields.length) { out.push({ type: event.type }); continue; }
    const data = event.data || {}, kept = {};
    for (const k of fields) { const v = data[k]; if (v !== undefined) kept[k] = v; }
    out.push({ type: event.type, data: kept });
  }
  return out;
}
// Rust chooses the result; these small probes preserve the original lazy property-read
// schedule for exported raw steps. Getters may change values or throw on a later read.
function rawStep(state, type, authoritative) {
  const reply = policy(6, [stateWire(state), { type: FOLD_FIELDS.has(type) ? type : null }, Boolean(authoritative), false]);
  if (reply.throws !== undefined) policyError(reply, { from: state });
  return reply.unchanged ? state : reply.state;
}
function rawAdvance(state, to) {
  const reply = policy(7, [stateWire(state), stateWire(to), state === to]);
  if (reply.throws !== undefined) policyError(reply, { from: state, to });
  return reply.unchanged ? state : reply.state;
}
function stageStep(state, data) {
  const firstTo = data.to;
  // A reflexive pair asks only whether this captured target is a known state.
  const known = policy(1, [stateWire(firstTo), stateWire(firstTo)]);
  if (known.throws !== undefined) policyError({ ...known, diagnostic: { site: 'event_to' } }, { to: firstTo });
  const firstFrom = data.from;
  const stale = policy(6, [stateWire(state), { type: 'task.stage', data: {
    from: stateWire(firstFrom), to: stateWire(firstTo),
  } }, false, firstFrom === state]);
  if (stale.throws === 'stale') policyError(stale, { from: state, data });
  // Rust's report-hash gate identifies whether the second target read needs the third
  // read and hash reads. This probe's anchor state never chooses the actual move.
  const nextTo = data.to;
  const gate = policy(6, [INITIAL_STATE, { type: 'task.stage', data: {
    from: INITIAL_STATE, to: stateWire(nextTo),
  } }, false, true]);
  if (gate.throws === 'report_hash' && data.to !== state) {
    const firstHash = data.reportHash;
    // RegExp.test in the original coerces its second read (but not the typeof read).
    // Template interpolation performs the same ToString, including throwing for Symbol.
    const hash = typeof firstHash === 'string' ? `${data.reportHash}` : null;
    const checked = policy(6, [INITIAL_STATE, { type: 'task.stage', data: {
      from: INITIAL_STATE, to: stateWire(nextTo), reportHash: hashWire(hash),
    } }, false, true]);
    if (checked.throws === 'report_hash') {
      policyError(checked, { from: state, to: data.to, rawMovement: true });
    }
  }
  return pair(3, state, data.to).state;
}
function step(state, event, { authoritative = false } = {}) {
  if (!event || typeof event.type !== 'string') return rawStep(state, null, authoritative);
  const data = event.data || {};
  if (event.type === 'task.stage') return stageStep(state, data);
  if (event.type === 'task.revision') return rawStep(state, 'task.revision', authoritative);
  if (authoritative) {
    // These comparisons schedule the same lazy reads as the old short-circuit expression;
    // Rust still decides whether the resulting event moves or preserves the raw state.
    let type = event.type;
    if (type !== 'job.failed') {
      type = event.type;
      if (type !== 'job.cancelled') {
        type = event.type;
        if (type !== 'job.interrupted') type = null;
      }
    }
    return rawStep(state, type, authoritative);
  }
  const type = event.type;
  if (type === 'progress') {
    const firstStage = data.stage;
    const gate = policy(6, [INITIAL_STATE, { type, data: { stage: stateWire(firstStage) } }, false, false]);
    if (gate.unchanged) return state;
    return rawAdvance(state, data.stage);
  }
  return rawStep(state, type, false);
}
// This loop contains no policy rules: every step and every error comes from Rust. Each event
// crosses once with bounded scalar fields; no repeated prefix or growing journal is re-sent.
function policyFold(events, fromState, options) {
  const start = policy(4, [[], stateWire(fromState), false]);
  if (start.throws !== undefined) return policyError(start, { fromState });
  let state = fromState;
  for (const event of events || []) state = step(state, event, options);
  return state;
}
function foldEvents(events, fromState = INITIAL_STATE, options = {}) {
  const { wasmLoader = defaultLoader, ...opts } = options || {};
  const state = policyFold(events, fromState, options);
  return confirmState(() => wasmLoader().taskLifecycleFold(foldInput(events), fromState, Boolean(opts.authoritative)), state);
}
function confirmFold(events, state, options = {}) {
  const { wasmLoader = defaultLoader, ...opts } = options || {};
  try { return confirmState(() => wasmLoader().taskLifecycleFold(foldInput(events), INITIAL_STATE, Boolean(opts.authoritative)), state); }
  catch { return null; }
}
function deriveLifecycle(events, { wasmLoader = defaultLoader } = {}) {
  const state = policyFold(events, INITIAL_STATE, { authoritative: isAuthoritative(events) });
  return confirmState(() => wasmLoader().taskLifecycleDerive(foldInput(events)), state);
}
function safeDeriveLifecycle(events, options) {
  try { return deriveLifecycle(events, options); }
  catch (error) { if (error instanceof TaskLifecycleError) return null; throw error; }
}
function canTransitionToReviewing(from, report, options) {
  return canTransition(from, 'reviewing', options) && canEnterReviewing(report);
}
module.exports = {
  STATES, INITIAL_STATE, AUTHORITY_TYPES, isAuthoritative, assertStageMove, TRANSITIONS,
  TaskLifecycleError, canTransition, transition, step, foldEvents, deriveLifecycle,
  safeDeriveLifecycle, canTransitionToReviewing, confirmFold, foldInput,
};
