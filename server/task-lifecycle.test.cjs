'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  STATES, INITIAL_STATE, TRANSITIONS, TaskLifecycleError,
  canTransition, transition, step, foldEvents, deriveLifecycle, safeDeriveLifecycle,
} = require('./task-lifecycle.cjs');

// --- Helpers to build synthetic journals in the same shape jobs.cjs appends. Never real
// Diary prompts/corpus — these are invented event streams for this module only.
let seq = 0;
const ev = (type, data = {}) => ({ job: 'synthetic', seq: ++seq, type, at: seq, data });

// --- Exhaustive transition table coverage: every declared legal pair must succeed, every
// other ordered pair (including self-loops not explicitly listed, and unknown states) must
// be rejected with an explicit TaskLifecycleError.

test('every declared transition is legal in both canTransition and transition', () => {
  for (const from of STATES) {
    for (const to of TRANSITIONS[from]) {
      assert.equal(canTransition(from, to), true, `${from} -> ${to} should be legal`);
      assert.equal(transition(from, to), to);
    }
  }
});

test('staying in the same state is always legal, even from the terminal state', () => {
  for (const state of STATES) {
    assert.equal(canTransition(state, state), true);
    assert.equal(transition(state, state), state);
  }
});

test('every non-declared, non-identity pair is illegal and throws TaskLifecycleError', () => {
  let checked = 0;
  for (const from of STATES) {
    for (const to of STATES) {
      if (to === from) continue;
      if (TRANSITIONS[from].includes(to)) continue;
      checked++;
      assert.throws(() => transition(from, to), TaskLifecycleError, `${from} -> ${to} should be illegal`);
      assert.equal(canTransition(from, to), false, `${from} -> ${to} should be illegal`);
    }
  }
  // Sanity: this test actually exercised illegal pairs (guards against a vacuous pass if
  // someone widens the table to allow everything).
  assert.ok(checked > 10, `expected several illegal pairs, saw ${checked}`);
});

test('merged is terminal: no outgoing transitions to any other state', () => {
  for (const to of STATES) {
    if (to === 'merged') continue;
    assert.throws(() => transition('merged', to), TaskLifecycleError);
  }
});

test('illegal transitions name the offending states on the thrown error', () => {
  try {
    transition('planned', 'merged');
    assert.fail('expected a throw');
  } catch (e) {
    assert.ok(e instanceof TaskLifecycleError);
    assert.equal(e.from, 'planned');
    assert.equal(e.to, 'merged');
    assert.match(e.message, /planned -> merged/);
    assert.equal(e.status, 409);
  }
});

test('unknown states are rejected explicitly, not silently coerced', () => {
  assert.throws(() => transition('planned', 'shipped'), TaskLifecycleError);
  assert.throws(() => transition('done', 'planned'), TaskLifecycleError);
});

test('the full legal map matches the documented design (spot check)', () => {
  assert.deepEqual([...TRANSITIONS.planned], ['implementing', 'blocked']);
  assert.deepEqual([...TRANSITIONS.merged], []);
  assert.ok(TRANSITIONS.reviewing.includes('changes_requested'));
  assert.ok(TRANSITIONS.reviewing.includes('implementing'), 'an approved review resumes implementing');
  assert.ok(TRANSITIONS.changes_requested.includes('merged'), 'a task can still complete after a declined tool call with no further activity');
  assert.ok(TRANSITIONS.blocked.includes('implementing') && TRANSITIONS.blocked.includes('planned'));
});

// --- Derivation from synthetic journals mirroring jobs.cjs's real event vocabulary.
//
// Honesty constraint (#522 review, both rounds): today's job kinds have no real reviewer and
// no real merge step. `approval.requested`/`approval.decided` are the per-tool-call
// write-approval gate, not a task review, and `job.completed` just means the harness finished.
// The derivation must therefore NEVER reach `reviewing`, `changes_requested` or `merged` from
// today's event vocabulary — not even via a `review`/`merged` key in an event's `data`, because
// that data is sourced from approval cards and harness results that model or page content can
// influence (browser-service.cjs spreads `{ ...card, jobId }` into `approval.requested`). A
// real future reviewer/merge feature must use its own dedicated, server-only event types
// instead (see the module header) — never a spoofable flag on an existing one.

test('a bare job.created with nothing else derives the initial planned state', () => {
  seq = 0;
  const events = [ev('job.created', { kind: 'chat' })];
  assert.equal(deriveLifecycle(events), 'planned');
});

test('job.started moves planned -> implementing', () => {
  seq = 0;
  const events = [ev('job.created'), ev('job.started')];
  assert.equal(deriveLifecycle(events), 'implementing');
});

test('an ordinary completed job (chat/browser/code shaped) derives verifying, never merged', () => {
  for (const kind of ['chat', 'browser', 'code', 'research', 'source']) {
    seq = 0;
    const events = [
      ev('job.created', { kind }),
      ev('job.started'),
      ev('step.started', { id: '1', title: 'work' }),
      ev('progress', { stage: 'Reading' }), // free-text stage, not a canonical lifecycle token
      ev('step.completed', { id: '1' }),
      ev('job.completed', { result: { ok: true } }),
    ];
    assert.equal(deriveLifecycle(events), 'verifying', `kind=${kind}`);
  }
});

test('a routine per-tool-call write-approval (no review flag) never becomes reviewing', () => {
  seq = 0;
  const events = [
    ev('job.created', { kind: 'code' }),
    ev('job.started'),
    ev('approval.requested', { action: 'shell.exec', command: 'rm -rf /tmp/x' }),
    ev('approval.decided', { decision: 'approve', action: 'shell.exec' }),
    ev('job.completed', {}),
  ];
  assert.equal(deriveLifecycle(events), 'verifying');
});

test('a declined per-tool-call approval (no review flag) never becomes changes_requested', () => {
  for (const decision of ['deny', 'denied', 'reject', 'reject_once', 'aborted', undefined]) {
    seq = 0;
    const events = [
      ev('job.created', { kind: 'browser' }), ev('job.started'),
      ev('approval.requested', { action: 'click' }),
      ev('approval.decided', { decision, action: 'click' }),
      ev('job.completed', {}),
    ];
    assert.equal(deriveLifecycle(events), 'verifying', `decision=${JSON.stringify(decision)}`);
  }
});

test('multiple, even duplicate, ordinary approval requests in a row stay a no-op', () => {
  seq = 0;
  const events = [
    ev('job.created'), ev('job.started'),
    ev('approval.requested', { action: 'a' }), ev('approval.decided', { decision: 'approve', action: 'a' }),
    ev('approval.requested', { action: 'a' }), ev('approval.decided', { decision: 'deny', action: 'a' }),
    ev('approval.requested', { action: 'a' }), // duplicate request with no intervening decision
  ];
  assert.equal(deriveLifecycle(events), 'implementing');
});

test('a canonical "verifying" progress stage is recognized', () => {
  seq = 0;
  const events = [ev('job.created'), ev('job.started'), ev('progress', { stage: 'verifying' }), ev('job.completed')];
  assert.equal(deriveLifecycle(events), 'verifying');
});

test('a free-text "reviewing" progress stage is NOT recognized (not an explicit review)', () => {
  seq = 0;
  const events = [ev('job.created'), ev('job.started'), ev('progress', { stage: 'reviewing' })];
  assert.equal(deriveLifecycle(events), 'implementing');
});

test('a job that fails ends up blocked, regardless of how far it had progressed', () => {
  for (const extra of [[], [ev('progress', { stage: 'verifying' })], [ev('approval.requested', {})]]) {
    seq = 0;
    const events = [ev('job.created'), ev('job.started'), ...extra, ev('job.failed', { error: 'boom' })];
    assert.equal(deriveLifecycle(events), 'blocked');
  }
});

test('a job cancelled or interrupted also lands on blocked', () => {
  seq = 0;
  assert.equal(deriveLifecycle([ev('job.created'), ev('job.started'), ev('job.cancelled')]), 'blocked');
  seq = 0;
  assert.equal(deriveLifecycle([ev('job.created'), ev('job.started'), ev('job.interrupted', { reason: 'restart' })]), 'blocked');
});

// --- Spoof resistance: a `review`/`merged` key in an event's `data` must never be honoured.
// This is the exact attack the second #522 review round called out: browser-service.cjs builds
// `approval.requested`'s data by spreading a page/model-influenced `card`, and `job.completed`'s
// `result` similarly comes from harness/model output, so either could carry a forged flag.

test('a spoofed approval.requested { review: true } never reaches reviewing', () => {
  seq = 0;
  const events = [ev('job.created'), ev('job.started'), ev('approval.requested', { review: true, action: 'exfiltrate' })];
  assert.equal(deriveLifecycle(events), 'implementing');
});

test('a spoofed approval.decided { review: true, decision: "deny" } never reaches changes_requested', () => {
  seq = 0;
  const events = [
    ev('job.created'), ev('job.started'),
    ev('approval.requested', { review: true }),
    ev('approval.decided', { review: true, decision: 'deny' }),
  ];
  assert.equal(deriveLifecycle(events), 'implementing');
});

test('a spoofed job.completed { merged: true } never reaches merged', () => {
  seq = 0;
  const events = [ev('job.created'), ev('job.started'), ev('job.completed', { merged: true, result: { forged: true } })];
  assert.equal(deriveLifecycle(events), 'verifying');
});

test('a spoofed full review/merge-shaped journal still only ever reaches implementing/verifying/blocked', () => {
  seq = 0;
  const events = [
    ev('job.created', { kind: 'code' }),
    ev('job.started'),
    ev('progress', { stage: 'verifying' }),
    ev('approval.requested', { review: true }),
    ev('approval.decided', { review: true, decision: 'deny' }),
    ev('approval.requested', { review: true }),
    ev('approval.decided', { review: true, decision: 'approve' }),
    ev('progress', { stage: 'verifying' }),
    ev('job.completed', { merged: true }),
  ];
  assert.equal(deriveLifecycle(events), 'verifying');
});

test('unrecognized event types and non-canonical stages are no-ops', () => {
  seq = 0;
  const events = [
    ev('job.created'), ev('job.started'),
    ev('tool.started', { id: 't1' }), ev('tool.completed', { id: 't1' }),
    ev('tool.uncertain', {}), ev('artifact.created', { name: 'a' }),
    ev('checkpoint.created', { step: 1 }),
    ev('plan.proposed', { question: 'q' }),
    ev('progress', { stage: 'Downloading' }), // not canonical
    ev('assistant.output', { text: 'hi' }),
  ];
  assert.equal(deriveLifecycle(events), 'implementing');
});

test('an empty event list derives the initial state', () => {
  assert.equal(deriveLifecycle([]), 'planned');
  assert.equal(foldEvents([]), 'planned');
});

// --- Restart / replay determinism.

test('folding all events at once equals folding in arbitrary chunks', () => {
  seq = 0;
  const events = [
    ev('job.created'), ev('job.started'),
    ev('progress', { stage: 'verifying' }),
    ev('approval.requested', { review: true }), ev('approval.decided', { review: true, decision: 'deny' }),
    ev('approval.requested', { review: true }), ev('approval.decided', { review: true, decision: 'approve' }),
    ev('job.completed', { merged: true }),
  ];
  const whole = deriveLifecycle(events);
  assert.equal(whole, 'verifying'); // the review/merged data flags above are inert (see spoof-resistance tests)
  for (let cut = 1; cut < events.length; cut++) {
    const first = foldEvents(events.slice(0, cut));
    const resumed = foldEvents(events.slice(cut), first);
    assert.equal(resumed, whole, `chunking at ${cut} diverged`);
  }
});

test('replaying the same journal twice from scratch is deterministic', () => {
  seq = 0;
  const events = [ev('job.created'), ev('job.started'), ev('approval.requested', {}), ev('approval.decided', { decision: 'approve' })];
  const first = deriveLifecycle(events);
  const second = deriveLifecycle(events.map((e) => ({ ...e }))); // fresh objects, same content
  assert.equal(first, second);
  assert.equal(first, 'implementing');
});

test('deriving from a fresh copy of the events array does not mutate the input', () => {
  seq = 0;
  const events = [ev('job.created'), ev('job.started')];
  const snapshot = JSON.stringify(events);
  deriveLifecycle(events);
  assert.equal(JSON.stringify(events), snapshot);
});

// --- The single-event `step()` primitive, exposed so a caller (jobs.cjs) can fold the
// lifecycle in the same pass as its own derive() loop instead of re-reading the journal.

test('step() applied event-by-event matches foldEvents()/deriveLifecycle() over the same events', () => {
  seq = 0;
  const events = [ev('job.created'), ev('job.started'), ev('progress', { stage: 'verifying' }), ev('job.completed', { merged: true })];
  let manual = INITIAL_STATE;
  for (const e of events) manual = step(manual, e);
  assert.equal(manual, deriveLifecycle(events));
  assert.equal(manual, 'verifying'); // the `merged: true` data flag above is inert
});

// --- safeDeriveLifecycle: never throws, even on a journal shaped to force an illegal jump.

test('safeDeriveLifecycle returns null instead of throwing on an illegal derived jump', () => {
  seq = 0;
  // planned -> verifying directly (job.completed with no job.started) is illegal per the table.
  const events = [ev('job.created'), ev('job.completed', {})];
  assert.throws(() => deriveLifecycle(events), TaskLifecycleError);
  assert.equal(safeDeriveLifecycle(events), null);
});

test('safeDeriveLifecycle still returns the real state for a well-formed journal', () => {
  seq = 0;
  const events = [ev('job.created'), ev('job.started'), ev('job.completed', {})];
  assert.equal(safeDeriveLifecycle(events), 'verifying');
});

test('foldEvents rejects an unknown starting state explicitly', () => {
  assert.throws(() => foldEvents([], 'not-a-state'), TaskLifecycleError);
});

test('STATES and INITIAL_STATE match the states named in the issue', () => {
  assert.deepEqual([...STATES].sort(), [
    'blocked', 'changes_requested', 'implementing', 'merged', 'planned', 'reviewing', 'verifying',
  ].sort());
  assert.equal(INITIAL_STATE, 'planned');
});
