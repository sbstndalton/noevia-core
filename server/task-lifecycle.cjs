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
  verifying: Object.freeze(['reviewing', 'implementing', 'merged', 'blocked']),
  reviewing: Object.freeze(['implementing', 'changes_requested', 'merged', 'blocked']),
  changes_requested: Object.freeze(['implementing', 'reviewing', 'merged', 'blocked']),
  blocked: Object.freeze(['implementing', 'planned']),
  merged: Object.freeze([]),
});

class TaskLifecycleError extends Error {
  constructor(message, { from, to } = {}) {
    super(message);
    this.name = 'TaskLifecycleError';
    this.from = from;
    this.to = to;
    this.status = 409;
  }
}

function assertKnownState(state, label) {
  if (!STATE_SET.has(state)) {
    throw new TaskLifecycleError(`Unknown task-lifecycle state: ${label} = ${JSON.stringify(state)}`, { [label]: state });
  }
}

// True/false, never throws. Staying in the same state is always allowed (a no-op transition).
function canTransition(from, to) {
  assertKnownState(from, 'from');
  assertKnownState(to, 'to');
  if (from === to) return true;
  return TRANSITIONS[from].includes(to);
}

// Guarded transition: returns `to` on success, throws TaskLifecycleError on an illegal move
// (including moves out of the terminal `merged` state, or into/out of an unknown state).
function transition(from, to) {
  if (!canTransition(from, to)) {
    throw new TaskLifecycleError(`Illegal task-lifecycle transition: ${from} -> ${to}`, { from, to });
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
    throw new TaskLifecycleError(`Stale task-lifecycle stage: recorded from ${JSON.stringify(data.from)} but the task is ${state}`, { from: data.from, to: data.to });
  }
  if (data.to === 'reviewing' && data.to !== state && !REPORT_HASH.test(String(data.reportHash || ''))) {
    throw new TaskLifecycleError('Entering reviewing needs the hash of the completeness report that allowed it', { from: state, to: data.to });
  }
  return assertStageMove(state, data.to);
}

// The pipeline's own moves are stricter than the general table: a task reaches `merged` only
// from `reviewing`, never straight from implementing/verifying/changes_requested.
function assertStageMove(from, to) {
  if (to === 'merged' && from !== 'merged' && from !== 'reviewing') {
    throw new TaskLifecycleError(`A task is merged only from reviewing, not ${from}`, { from, to });
  }
  return transition(from, to);
}

function advance(from, to) {
  if (from === to) return from;
  return transition(from, to);
}

// Pure fold over an ordered event array (as produced by jobs.cjs's own journal reader),
// starting from `fromState` (defaults to the initial state). Deterministic and side-effect
// free: replaying the same events, in the same order, from the same starting state always
// yields the same result — including in chunks (fold(events.slice(0, k)) then
// fold(events.slice(k), thatResult) === fold(events)), which is what a server restart relies
// on: the journal is replayed from disk, not resumed from in-memory state.
function foldEvents(events, fromState = INITIAL_STATE, options = {}) {
  assertKnownState(fromState, 'fromState');
  let state = fromState;
  for (const event of events || []) state = step(state, event, options);
  return state;
}

// Convenience: derive the lifecycle state for a full journal from the beginning. Whether the
// journal is authoritative is decided by the whole journal (see the module header).
function deriveLifecycle(events) {
  return foldEvents(events, INITIAL_STATE, { authoritative: isAuthoritative(events) });
}

// Defensive variant for wiring into read paths that must never throw: returns null instead
// of raising when the journal implies an illegal transition (e.g. a job kind whose events
// were never authored with this lifecycle in mind). Never hides a bug from `transition()` or
// `deriveLifecycle()` themselves — only from call sites that attach this as extra, optional
// information on top of an existing, already-correct job object.
function safeDeriveLifecycle(events) {
  try {
    return deriveLifecycle(events);
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
function canTransitionToReviewing(from, report) {
  return canTransition(from, 'reviewing') && canEnterReviewing(report);
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
};
