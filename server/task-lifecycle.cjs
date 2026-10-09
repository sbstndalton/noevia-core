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
// TASK_LIFECYCLE_IMPL=js|wasm (default js; any other value means js, with one warning), read from the
// `env` option (process.env) on every call of canTransition, transition, assertStageMove,
// foldEvents, deriveLifecycle, safeDeriveLifecycle and confirmFold. wasm also asks noevia-rs's
// task-lifecycle crate (dav-parse.wasm task_lifecycle) for the same answer. The JS answer is always
// computed first and is the only one ever returned: a move is allowed only when both allow it.
// When the JS throws, the port is not asked. When the JS allows and the port refuses, faults,
// replies badly or disagrees, canTransition answers false and the others throw TaskLifecycleError
// (code 'impl_refused' / 'impl_mismatch', status 409; logged once per reason, journal-text free),
// so jobs.cjs's existing paths refuse the stage write and derive no lifecycle (null). step() is
// the JS alone; jobs.cjs derive() confirms its whole fold once through confirmFold(). The flag is
// in dav-parse-wasm.cjs IMPL_FLAGS (a missing or tampered module stops startup).
// Stricter than the JS (the crate docs): a journal over 8 MiB as JSON, one JSON.stringify cannot
// write, and a task.stage entering reviewing whose reportHash is an array or object (the JS reads
// it through String()) are refused. canTransitionToReviewing's completeness half
// (completeness-report.cjs canEnterReviewing) is not part of this port.

const { canEnterReviewing } = require('./completeness-report.cjs');

const STATES = Object.freeze([
  'planned',
  'implementing',
  'verifying',
  'reviewing',
  'changes_requested',
  'merged',
  'blocked',
]);
const STATE_SET = new Set(STATES);
const INITIAL_STATE = 'planned';
// The server-only lifecycle authority events (#701). See the module header.
const AUTHORITY_TYPES = Object.freeze(new Set(['task.stage', 'task.revision']));
const REPORT_HASH = /^[0-9a-f]{64}$/;
const isAuthoritative = (events) => (events || []).some((e) => e && AUTHORITY_TYPES.has(e.type));

// Guarded transition table: the only legal moves. `merged` is terminal (no outgoing edges).
// Anything not listed here is illegal and `transition()` throws for it. `reviewing`,
// `changes_requested` and `merged` are part of this table for a future real review/merge
// feature to drive (see the module header); today's derivation never targets them.
const TRANSITIONS = Object.freeze({
  planned: Object.freeze(['implementing', 'blocked']),
  implementing: Object.freeze(['verifying', 'reviewing', 'merged', 'blocked']),
  // verifying → changes_requested: the operator's tests failed (#705), the same loop a review's
  // "request changes" starts.
  verifying: Object.freeze(['reviewing', 'implementing', 'changes_requested', 'merged', 'blocked']),
  reviewing: Object.freeze(['implementing', 'changes_requested', 'merged', 'blocked']),
  changes_requested: Object.freeze(['implementing', 'reviewing', 'merged', 'blocked']),
  blocked: Object.freeze(['implementing', 'planned']),
  merged: Object.freeze([]),
});

class TaskLifecycleError extends Error {
  constructor(message, { from, to, code } = {}) {
    super(message);
    this.name = 'TaskLifecycleError';
    this.from = from;
    this.to = to;
    // What went wrong, for TASK_LIFECYCLE_IMPL's comparison: unknown_state, illegal, stale,
    // report_hash, merge_from_reviewing, or (the port's refusal) impl_refused / impl_mismatch.
    this.code = code;
    this.status = 409;
  }
}

function assertKnownState(state, label) {
  if (!STATE_SET.has(state)) {
    throw new TaskLifecycleError(`Unknown task-lifecycle state: ${label} = ${JSON.stringify(state)}`, { [label]: state, code: 'unknown_state' });
  }
}

// True/false; throws only for an unknown state. Staying in the same state is always allowed (a
// no-op transition). The JS table alone; canTransition below adds TASK_LIFECYCLE_IMPL.
function canTransitionJs(from, to) {
  assertKnownState(from, 'from');
  assertKnownState(to, 'to');
  if (from === to) return true;
  return TRANSITIONS[from].includes(to);
}

// Guarded transition: returns `to` on success, throws TaskLifecycleError on an illegal move
// (including moves out of the terminal `merged` state, or into/out of an unknown state).
function transitionJs(from, to) {
  if (!canTransitionJs(from, to)) {
    throw new TaskLifecycleError(`Illegal task-lifecycle transition: ${from} -> ${to}`, { from, to, code: 'illegal' });
  }
  return to;
}

// Caller-chosen `progress` stage tokens this layer treats as meaningful. Deliberately does
// NOT include 'reviewing': a free-text progress stage is never treated as evidence that a
// real review happened. Any other stage string (the vast majority of existing job kinds use
// free-text stages for UI display) is ignored here, exactly as before this module existed.
const CANONICAL_STAGES = new Set(['implementing', 'verifying']);

// One step of the fold: applies a single existing jobs.cjs journal event to a lifecycle
// state and returns the next state. Exported as a low-level primitive so a caller that
// already loops over a job's events once (jobs.cjs's own `derive()`) can fold the lifecycle
// in that same pass instead of re-reading the journal a second time.
//
// - `job.created` / unrecognized types (step.*, tool.*, artifact.created, checkpoint.created,
//   tool.uncertain, plan.*, assistant.output) are no-ops.
// - `job.started` moves to `implementing`.
// - `progress` only acts on the canonical stages above.
// - `approval.requested` / `approval.decided` are today's per-tool-call write-approval gate,
//   not a task-level review, and their `data` is attacker/model-reachable (see module header)
//   — they are ALWAYS a no-op here, unconditionally, with no data-carried override.
// - `job.completed` means the harness finished, not that anyone reviewed or merged it: it
//   ALWAYS moves to `verifying`, unconditionally, with no data-carried override.
// - `job.failed` / `job.cancelled` / `job.interrupted` all move to `blocked`.
//
// With `{ authoritative: true }` (a journal carrying a lifecycle authority event, #701):
// - `task.stage` moves through `transition()`; its `from` must be the current state, and
//   entering `reviewing` must carry the hash of the completeness report that allowed it.
// - `task.revision` is a no-op here (jobs.cjs derives the revision itself).
// - job.started / progress / job.completed / approval.* are no-ops: only the pipeline says
//   where an authoritative task is.
// - job.failed / job.cancelled / job.interrupted still force `blocked`, except out of the
//   terminal `merged`, which they leave alone (the merge already happened).
function step(state, event, { authoritative = false } = {}) {
  if (!event || typeof event.type !== 'string') return state;
  const data = event.data || {};
  if (event.type === 'task.stage') return stageStep(state, data);
  if (event.type === 'task.revision') return state;
  if (authoritative) {
    if (event.type === 'job.failed' || event.type === 'job.cancelled' || event.type === 'job.interrupted') {
      return state === 'merged' ? state : advance(state, 'blocked');
    }
    return state;
  }
  switch (event.type) {
    case 'job.created':
      return state; // already `planned` (or wherever a prior fold left it)
    case 'job.started':
      return advance(state, 'implementing');
    case 'progress':
      return CANONICAL_STAGES.has(data.stage) ? advance(state, data.stage) : state;
    case 'approval.requested':
    case 'approval.decided':
      // Never a review: this is the per-tool-call write-approval gate, and its data is
      // sourced from the approval card / harness output, which model or page content can
      // influence. No key in `data` can move the lifecycle here — see module header.
      return state;
    case 'job.completed':
      // Never a merge: only that the harness finished. No key in `data` (including the
      // harness/model-influenced `result`) can move this to `merged` — see module header.
      return advance(state, 'verifying');
    case 'job.failed':
    case 'job.cancelled':
    case 'job.interrupted':
      return advance(state, 'blocked');
    default:
      return state;
  }
}

// A derived jump that is illegal per the guarded table is rejected the same way an explicit
// caller-driven `transition()` would be: this is what "illegal transitions are rejected with
// explicit errors" means for derivation too. Callers deriving lifecycle from a real job's
// journal (task-lifecycle-wiring is defensive — see jobs.cjs) should expect this can throw
// on a journal that was never shaped with this layer in mind, and treat that as "no derived
// lifecycle available" rather than a crash.
function stageStep(state, data) {
  assertKnownState(data.to, 'to');
  if (data.from !== state) {
    throw new TaskLifecycleError(`Stale task-lifecycle stage: recorded from ${JSON.stringify(data.from)} but the task is ${state}`, { from: data.from, to: data.to, code: 'stale' });
  }
  if (data.to === 'reviewing' && data.to !== state && !REPORT_HASH.test(String(data.reportHash || ''))) {
    throw new TaskLifecycleError('Entering reviewing needs the hash of the completeness report that allowed it', { from: state, to: data.to, code: 'report_hash' });
  }
  return assertStageMoveJs(state, data.to);
}

// The pipeline's own moves are stricter than the general table: a task reaches `merged` only
// from `reviewing`, never straight from implementing/verifying/changes_requested.
function assertStageMoveJs(from, to) {
  if (to === 'merged' && from !== 'merged' && from !== 'reviewing') {
    throw new TaskLifecycleError(`A task is merged only from reviewing, not ${from}`, { from, to, code: 'merge_from_reviewing' });
  }
  return transitionJs(from, to);
}

function advance(from, to) {
  if (from === to) return from;
  return transitionJs(from, to);
}

// Pure fold over an ordered event array (as produced by jobs.cjs's own journal reader),
// starting from `fromState` (defaults to the initial state). Deterministic and side-effect
// free: replaying the same events, in the same order, from the same starting state always
// yields the same result — including in chunks (fold(events.slice(0, k)) then
// fold(events.slice(k), thatResult) === fold(events)), which is what a server restart relies
// on: the journal is replayed from disk, not resumed from in-memory state.
function foldEventsJs(events, fromState, options) {
  assertKnownState(fromState, 'fromState');
  let state = fromState;
  for (const event of events || []) state = step(state, event, options);
  return state;
}

// ── TASK_LIFECYCLE_IMPL ─────────────────────────────────────────────────────

const IMPLS = new Set(['js', 'wasm']);
let warnedImpl = '';
/** TASK_LIFECYCLE_IMPL: 'js' (default) or 'wasm'. */
function taskLifecycleImpl(env = process.env) {
  const raw = env?.TASK_LIFECYCLE_IMPL;
  if (raw === undefined || raw === '') return 'js';
  const value = String(raw).trim().toLowerCase();
  if (IMPLS.has(value)) return value;
  if (warnedImpl !== value) {
    warnedImpl = value;
    console.warn(`[task-lifecycle] TASK_LIFECYCLE_IMPL=${JSON.stringify(String(raw))} is not js or wasm; using js`);
  }
  return 'js';
}
const defaultLoader = () => require('./dav-parse-wasm.cjs');
const implOf = ({ env = process.env, impl = taskLifecycleImpl(env) } = {}) => impl;

const warnedPort = new Set();
function portWarn(event, reason) {
  const key = `${event}:${reason}`;
  if (warnedPort.has(key)) return;
  warnedPort.add(key);
  console.warn(`[task-lifecycle] ${event} (${reason}); the transition was refused`);
}

// The port's answer for a call the JS already answered: `{ state }`, `{ allowed }` or `{ throws }`
// as the port saw it, or null after a refusal or fault (logged).
function askPort(ask) {
  try {
    return ask();
  } catch (err) {
    portWarn('task_lifecycle.wasm_fault', String(err?.reason || 'unexpected').slice(0, 40));
    return null;
  }
}

// The JS answer `state` stands only if the port gives the same state. Throws otherwise.
function confirmState(ask, state) {
  const port = askPort(ask);
  if (!port) throw new TaskLifecycleError('Task lifecycle refused by the Rust port', { code: 'impl_refused' });
  if (port.state !== state) {
    portWarn('task_lifecycle.impl_mismatch', port.throws !== undefined ? 'throws' : 'state');
    throw new TaskLifecycleError('Task lifecycle disagrees with the Rust port', { code: 'impl_mismatch' });
  }
  return state;
}

/** canTransition(from, to): with TASK_LIFECYCLE_IMPL=wasm, true only when the port also allows.
 *  Throws (unknown state) only where the JS does. Options: `env`, `impl`, `wasmLoader`. */
function canTransition(from, to, { wasmLoader = defaultLoader, ...opts } = {}) {
  const allowed = canTransitionJs(from, to);
  if (!allowed || implOf(opts) !== 'wasm') return allowed;
  const port = askPort(() => wasmLoader().taskLifecycleCanTransition(from, to));
  if (port && port.allowed === true) return true;
  if (port) portWarn('task_lifecycle.impl_mismatch', port.throws !== undefined ? 'throws' : 'allowed');
  return false;
}

/** Guarded transition: returns `to` on success, throws TaskLifecycleError on an illegal move
 *  (including moves out of the terminal `merged` state, or into/out of an unknown state), and
 *  with TASK_LIFECYCLE_IMPL=wasm when the port does not allow it too. */
function transition(from, to, { wasmLoader = defaultLoader, ...opts } = {}) {
  const state = transitionJs(from, to);
  if (implOf(opts) !== 'wasm') return state;
  return confirmState(() => wasmLoader().taskLifecycleTransition(from, to), state);
}

/** The pipeline's own move (see assertStageMoveJs), confirmed by the port under wasm. */
function assertStageMove(from, to, { wasmLoader = defaultLoader, ...opts } = {}) {
  const state = assertStageMoveJs(from, to);
  if (implOf(opts) !== 'wasm') return state;
  return confirmState(() => wasmLoader().taskLifecycleStageMove(from, to), state);
}

/** foldEventsJs (below the module header's rules), confirmed by the port under wasm. Options:
 *  `authoritative`, `env`, `impl`, `wasmLoader`. */
function foldEvents(events, fromState = INITIAL_STATE, options = {}) {
  const { wasmLoader = defaultLoader, ...opts } = options || {};
  const state = foldEventsJs(events, fromState, options);
  if (implOf(opts) !== 'wasm') return state;
  return confirmState(() => wasmLoader().taskLifecycleFold(events ?? null, fromState, Boolean(opts.authoritative)), state);
}

/** For a caller that folded `events` itself with step() from INITIAL_STATE (jobs.cjs derive()):
 *  `state` under js; under wasm `state` only when the port folds the same journal to it, else
 *  null ("no derived lifecycle available"). Never throws. */
function confirmFold(events, state, options = {}) {
  const { wasmLoader = defaultLoader, ...opts } = options || {};
  if (implOf(opts) !== 'wasm') return state;
  try {
    return confirmState(() => wasmLoader().taskLifecycleFold(events ?? null, INITIAL_STATE, Boolean(opts.authoritative)), state);
  } catch {
    return null;
  }
}

// Convenience: derive the lifecycle state for a full journal from the beginning. Whether the
// journal is authoritative is decided by the whole journal (see the module header).
function deriveLifecycle(events, { wasmLoader = defaultLoader, ...opts } = {}) {
  const state = foldEventsJs(events, INITIAL_STATE, { authoritative: isAuthoritative(events) });
  if (implOf(opts) !== 'wasm') return state;
  return confirmState(() => wasmLoader().taskLifecycleDerive(events ?? null), state);
}

// Defensive variant for wiring into read paths that must never throw: returns null instead
// of raising when the journal implies an illegal transition (e.g. a job kind whose events
// were never authored with this lifecycle in mind). Never hides a bug from `transition()` or
// `deriveLifecycle()` themselves — only from call sites that attach this as extra, optional
// information on top of an existing, already-correct job object.
function safeDeriveLifecycle(events, options) {
  try {
    return deriveLifecycle(events, options);
  } catch (e) {
    if (e instanceof TaskLifecycleError) return null;
    throw e;
  }
}

// Pure guard for a future `transition()` caller entering `reviewing` (#514, part of #511):
// legal per the guarded state table AND the deterministic completeness report
// (completeness-report.cjs) says nothing required is failing or unknown. Exported only —
// nothing in this module calls it, `step()`/`deriveLifecycle()` are completely unaffected, and
// today's derivation still NEVER reaches `reviewing` on its own (see the module header). A
// future real review/merge feature calls this before its own `transition(from, 'reviewing')`.
function canTransitionToReviewing(from, report, options) {
  return canTransition(from, 'reviewing', options) && canEnterReviewing(report);
}

module.exports = {
  STATES,
  INITIAL_STATE,
  AUTHORITY_TYPES,
  isAuthoritative,
  assertStageMove,
  TRANSITIONS,
  TaskLifecycleError,
  canTransition,
  transition,
  step,
  foldEvents,
  deriveLifecycle,
  safeDeriveLifecycle,
  canTransitionToReviewing,
  confirmFold,
  taskLifecycleImpl,
};
